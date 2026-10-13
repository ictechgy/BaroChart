// Generated from src/core; run npm run build:native.
(function(){
const RESOURCE_LIMITS=Object.freeze({maxBars:4194304,maxCanvasDimension:16384,maxCanvasPixels:33554432,maxDrawings:10000,maxDrawingPoints:200000,maxDocumentChars:8388608,maxHistoryBytes:33554432,maxPanels:32,maxAxes:64,maxSeries:256,maxIndicators:128});
function optionRecord(value,keys,label='Options') {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(`${label}: object required`);
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)throw new TypeError(`${label}: plain object required`);
 for(const key of Object.keys(value))if(['__proto__','constructor','prototype'].includes(key)||!keys.includes(key))throw new TypeError(`${label}: unsupported field ${key.slice(0,64)}`);
 return value;
}
function boundedText(value,max=128,label='Text',empty=false) {if(typeof value!=='string'||value.length>max||!empty&&!value.length)throw new TypeError(`${label}: string limit ${max}`);return value;}
function sizeLimit(value,max,label='Size') {if(!Number.isSafeInteger(value)||value<0||value>max)throw new RangeError(`${label}: limit ${max}`);return value;}
function identifier(value,label='Id') {boundedText(value,128,label);if(['__proto__','prototype','constructor'].includes(value))throw new TypeError(`${label}: reserved identifier`);return value;}
const PANEL_KEYS=['id','weight','label','scale','inverted','padding','range','base','precision','formatter','axisVisible','axisSide'];
const AXIS_KEYS=['id','panel','side','scale','inverted','padding','range','base','precision','tickFormat','prefix','suffix','label','visible','width','formatter'];
const SERIES_KEYS=['id','type','panel','source','values','indicator','output','color','fill','width','baseline','offset','upColor','downColor','visible','axisId','symbolId','label'];
const THEME_KEYS=['background','grid','text','up','down','crosshair','font'];
// Only callbacks installed by ChartAPI.setSymbol can be recreated in a new VM.
// A symbol object alone must not silently authorize replacement of custom callbacks.
const symbolFormatterRecords=new WeakMap();
function rememberSymbolFormatters(model){symbolFormatterRecords.set(model,{symbol:model.symbol,price:model.priceFormatter,time:model.timeFormatter});}
function hasPortableFormatters(model){const record=symbolFormatterRecords.get(model);return !model.priceFormatter&&!model.timeFormatter||!!record&&record.symbol===model.symbol&&record.price===model.priceFormatter&&record.time===model.timeFormatter;}

// Portable colors are normalized before crossing the native rendering boundary.
function portableColor(value) {
 if(typeof value!=='string')throw new TypeError('Color string required');boundedText(value,128,'Color');
 const names={black:'#000000',silver:'#c0c0c0',gray:'#808080',white:'#ffffff',maroon:'#800000',red:'#ff0000',purple:'#800080',fuchsia:'#ff00ff',green:'#008000',lime:'#00ff00',olive:'#808000',yellow:'#ffff00',navy:'#000080',blue:'#0000ff',teal:'#008080',aqua:'#00ffff',transparent:'#00000000'};
 let color=value.trim().toLowerCase();if(Object.hasOwn(names,color))color=names[color];
 if(/^#[\da-f]{3,4}$/.test(color))color='#'+[...color.slice(1)].map(c=>c+c).join('');
 if(/^#[\da-f]{6}$/.test(color))return color+'ff';if(/^#[\da-f]{8}$/.test(color))return color;
 const match=color.match(/^rgba?\(([^)]+)\)$/);
 if(match){const parts=match[1].split(',').map(x=>x.trim());if((parts.length===3||parts.length===4)&&parts.every(x=>/^\d*\.?\d+%?$/.test(x))){const rgb=parts.slice(0,3).map(x=>Number(x.replace('%',''))*(x.endsWith('%')?2.55:1)),alpha=parts.length===4?Number(parts[3].replace('%',''))*(parts[3].endsWith('%')?.01:1):1;if(rgb.every(x=>Number.isFinite(x)&&x>=0&&x<=255)&&Number.isFinite(alpha)&&alpha>=0&&alpha<=1)return '#'+[...rgb,alpha*255].map(x=>Math.round(x).toString(16).padStart(2,'0')).join('');}}
 throw new RangeError('Portable color: hex, comma RGB/RGBA or basic named color required');
}
function portableFont(value) {
 boundedText(value,256,'Font');const match=value.trim().match(/^((?:(?:bold|italic|normal)\s+)*)(\d+(?:\.\d+)?)px\s+([\w ."'\-,]+)$/);
 if(!match||Number(match[2])<4||Number(match[2])>96)throw new RangeError('Font size limit: 4..96px');return value.trim();
}
function portableStyle(options,colors=['color','fill','upColor','downColor'],preserveHex=false) {
 const next={...options};for(const key of colors)if(next[key]!==undefined&&!(key==='fill'&&next[key]===null)){const value=next[key];next[key]=preserveHex&&typeof value==='string'&&/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)?value:portableColor(value);}
 if(next.font!==undefined)next.font=portableFont(next.font);return next;
}

// Conservative portable layout bounds, not a native glyph measurement API.
// Fonts stay renderer-owned; explicit ellipsis preserves complete label metadata.
function labelMetrics(font) {
 const size=Number(String(font).match(/([0-9.]+)px/)?.[1]??12);
 return {size,ascent:size*1.12,descent:size*.38,height:size*1.5};
}
function labelWidth(value,metrics) {
 let units=0;for(const c of value){const code=c.codePointAt(0);units+=code>127?1.2:'MW@%'.includes(c)?.98:.74;}return units*metrics.size;
}
function fitLabel(value,maxWidth,metrics) {
 const fullText=String(value),singleLine=fullText.replace(/\s/g,' ');if(!(maxWidth>0))return null;
 const fullWidth=labelWidth(singleLine,metrics);if(fullWidth<=maxWidth)return {text:singleLine,fullText,width:fullWidth};
 const ellipsis='…',endWidth=labelWidth(ellipsis,metrics);if(endWidth>maxWidth)return null;
 let text='',width=0;for(const c of singleLine){const next=labelWidth(c,metrics);if(width+next+endWidth>maxWidth)break;text+=c;width+=next;}return {text:text+ellipsis,fullText,width:width+endWidth};
}
function labelCommand(value,x,y,maxWidth,font,color,clip,metadata={}) {
 const metrics=labelMetrics(font),fit=fitLabel(value,maxWidth,metrics);if(!fit)return null;
 return {op:'text',x,y,text:fit.text,fullText:fit.fullText,font,color,clip,labelBounds:[x,y-metrics.ascent,fit.width,metrics.height],...metadata};
}
function panelTitle(model,panel) {
 const labels=model.series.filter(s=>s.panel===panel.id&&s.visible!==false).map(s=>s.label??s.indicator).filter(Boolean);
 return [panel.label??panel.id,...new Set(labels)].join(' · ');
}

let storeSerial=0;
const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'];
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
function validateBar(b, previous = -Infinity) {
  if (!b || FIELDS.some(k => !Number.isFinite(b[k]))) throw new TypeError('Every OHLCV field must be finite');
  if (!Number.isSafeInteger(b.time) || Math.abs(b.time) > 8640000000000000) throw new RangeError('Time must be an exact UTC millisecond integer in the Date range');
  if (b.time <= previous) throw new RangeError('Times must be strictly increasing');
  if (b.volume < 0 || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close) || b.low > b.high) throw new RangeError('Invalid OHLCV envelope');
}

// Flat segment tree: O(log N) edits and range queries, O(N) bulk construction.
class RangeIndex {
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

class BarStore {
  #internalListeners = new Set();
  constructor(bars = [], {timeframeMs = 60000, timeOrigin = 0,maxBars=RESOURCE_LIMITS.maxBars,onListenerError=null} = {}) { if (!Number.isFinite(timeframeMs) || timeframeMs <= 0 || !Number.isFinite(timeOrigin)||onListenerError!==null&&typeof onListenerError!=='function') throw new RangeError('Virtual timeframe/origin or listener error callback');sizeLimit(maxBars,RESOURCE_LIMITS.maxBars,'Bar limit');this.geometryIdentity=++storeSerial;this.maxBars=maxBars;this.onListenerError=onListenerError;this.listenerErrors=[];this.pendingChanges=[];this.notifying=false; this.timeframeMs = timeframeMs; this.timeOrigin = timeOrigin; this.listeners = new Set(); this.version = 0;this.timeVersion=0; this.setData(bars); }
  setData(bars) {
    if(!Array.isArray(bars))throw new TypeError('OHLCV array required');sizeLimit(bars.length,this.maxBars,'Bar count');
    let capacity=16;while(capacity<bars.length)capacity*=2;
    const columns=Object.fromEntries(FIELDS.map(k=>[k,new Float64Array(capacity)])),scratch={};
    let previous = -Infinity;
    for(let i=0;i<bars.length;i++){readBar(bars[i],scratch);validateBar(scratch,previous);previous=scratch.time;for(const k of FIELDS)columns[k][i]=scratch[k];}
    const index=new RangeIndex(bars.length,columns.low,columns.high,columns.volume,capacity);
    Object.assign(this,{length:bars.length,capacity,columns,index});this.changed(0,'reset');
  }
  // Fast column load avoids a million transient bar objects. Validates atomically.
  setColumns(input, length = input?.time?.length, event = {kind: 'reset'}) {
    sizeLimit(length,this.maxBars,'Bar count');
    if(FIELDS.some(k=>!input?.[k]||!(Array.isArray(input[k])||ArrayBuffer.isView(input[k])&&!(input[k] instanceof DataView))||input[k].length<length))throw new TypeError('Numeric column arrays required');
    let capacity=16;while(capacity<length)capacity*=2;
    const columns=Object.fromEntries(FIELDS.map(k=>{const a=new Float64Array(capacity),source=input[k];if(ArrayBuffer.isView(source))a.set(Float64Array.prototype.subarray.call(source,0,length));else for(let i=0;i<length;i++){const value=source[i];if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('Numeric column values required');a[i]=value;}return [k,a];}));
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
    const limits=batchRecord(options,['maxBars','maxStoreBytes'],'Data batch options',[]),copied=batchEvents(events);
    if(beforeNotify!==null&&typeof beforeNotify!=='function')throw new TypeError('Internal data batch ledger function required');
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
    let columns=source.columns;
    if(capacity!==source.capacity){
      columns=Object.fromEntries(FIELDS.map(key=>{const array=new Float64Array(capacity);Float64Array.prototype.set.call(array,source.columns[key]);return [key,array];}));
    }
    const receipt=Object.freeze({events:copied.length,appended,from,to,version:source.version+1,length,capacity,bytes:96*capacity});
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
    bar=readBar(bar);validateBar(bar);
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
    start = Math.max(0, Math.floor(start)); end = Math.min(this.length, Math.ceil(end));
    if (end <= start) return [];
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1) throw new RangeError('Positive bucket count required');
    const n = Math.min(end - start, maxBuckets), c = this.columns, out = new Array(n);
    for (let b = 0; b < n; b++) {
      const a = start + Math.floor(b * (end - start) / n), z = start + Math.floor((b + 1) * (end - start) / n), q = this.index.query(a, z);
      out[b] = {start: a, end: z, index: (a + z - 1) / 2, time: c.time[a], open: c.open[a], high: q.max, low: q.min, close: c.close[z - 1], volume: q.sum};
    }
    return out;
  }
  get bytes() { return FIELDS.reduce((n, k) => n + this.columns[k].byteLength, this.index.bytes); }
}

function seededColumns(length, seed = 42) {
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

// Package-private lifetime ledger. Tokens never retain models or engines.
// An undisposed owner conservatively blocks in-place history compaction.
const storeOwnerLedgers=new WeakMap(),storeOwnerRecords=new WeakMap();
function registerStoreOwner(owner,store,kind){const token={kind};let tokens=storeOwnerLedgers.get(store);if(!tokens)storeOwnerLedgers.set(store,tokens=new Set());tokens.add(token);storeOwnerRecords.set(owner,{store,token});}
function unregisterStoreOwner(owner){const row=storeOwnerRecords.get(owner);if(!row)return;storeOwnerLedgers.get(row.store)?.delete(row.token);storeOwnerRecords.delete(owner);}
function exclusiveStoreOwners(store,model,engine){const m=storeOwnerRecords.get(model),e=storeOwnerRecords.get(engine),tokens=storeOwnerLedgers.get(store);return m?.store===store&&e?.store===store&&m.token.kind==='model'&&e.token.kind==='engine'&&tokens?.size===2&&tokens.has(m.token)&&tokens.has(e.token);}

// A tree over 32-value blocks bounds edge scans and reduces large-series trees.
class BlockRangeIndex {
 constructor(length,values,capacity=length,blockSize=32) {
  this.size=capacity;this.length=length;this.blockSize=blockSize;this.finiteCounts=true;
  this.values=new Float64Array(values.buffer,values.byteOffset,Math.min(capacity,(values.buffer.byteLength-values.byteOffset)/8));
  const count=Math.ceil(length/blockSize),blocks=Math.ceil(capacity/blockSize),min=new Float64Array(count),max=new Float64Array(count),finite=new Float64Array(count);
  for(let b=0;b<count;b++){const q=this.scan(b*blockSize,Math.min(length,(b+1)*blockSize),true);min[b]=q.min;max[b]=q.max;finite[b]=q.sum;}
  this.tree=new RangeIndex(count,min,max,finite,blocks);
 }
 scan(from,to,countFinite=false){let min=Infinity,max=-Infinity,count=0;for(let i=from,end=Math.min(to,this.length,this.values.length);i<end;i++){const value=this.values[i];if(Number.isFinite(value)){if(value<min)min=value;if(value>max)max=value;if(countFinite)count++;}}return {min,max,sum:count};}
 query(from,to){if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>this.size)throw new RangeError('Block index bounds');if(to<=from)return {min:Infinity,max:-Infinity,sum:0};const first=Math.ceil(from/this.blockSize),last=Math.floor(to/this.blockSize);if(first>=last)return this.scan(from,to);const left=this.scan(from,first*this.blockSize),right=this.scan(last*this.blockSize,to),middle=this.tree.query(first,last);return {min:Math.min(left.min,middle.min,right.min),max:Math.max(left.max,middle.max,right.max),sum:0};}
 scanCount(from,to){let count=0;for(let i=from;i<Math.min(to,this.length);i++)if(Number.isFinite(this.values[i]))count++;return count;}
 finiteCount(from,to){if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>this.size)throw new RangeError('Block index bounds');const first=Math.ceil(from/this.blockSize),last=Math.floor(to/this.blockSize);if(first>=last)return this.scanCount(from,to);return this.scanCount(from,first*this.blockSize)+this.tree._sumRange(first,last)+this.scanCount(last*this.blockSize,to);}
 hasGaps(from,to){return this.finiteCount(from,to)!==to-from;}
 update(i){if(!Number.isInteger(i)||i<0||i>=this.size)throw new RangeError('Block update bounds');this.length=Math.max(this.length,i+1);const block=Math.floor(i/this.blockSize),from=block*this.blockSize,to=Math.min(this.length,(block+1)*this.blockSize),q=this.scan(from,to,true);this.tree.update(block,q.min,q.max,q.sum);}
 get bytes(){return this.tree.bytes;}
}


// Shared per module/runtime, independent of chart lifetime. Keep reuse bounded
// and fold ASCII identifier case without depending on resolvedOptions (QuickJS's
// native timezone bridge exposes only formatToParts).
const formatters = new Map(),MARKET_TIMEZONE_FORMATTER_LIMIT=32;
function zonedParts(time, timezone) {
  if(typeof timezone!=='string'||!timezone.length||timezone.length>128)throw new TypeError('Timezone string, at most 128 characters required');
  const key=timezone.replace(/[A-Z]/g,char=>char.toLowerCase());let fmt=formatters.get(key);
  if(!fmt)fmt=new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
  const result=Object.fromEntries(fmt.formatToParts(new Date(time)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  // The native shim can reject a zone at formatToParts, after construction.
  // Failed calls neither insert nor refresh/evict successful cached entries.
  formatters.delete(key);formatters.set(key,fmt);if(formatters.size>MARKET_TIMEZONE_FORMATTER_LIMIT)formatters.delete(formatters.keys().next().value);
  return result;
}
function marketDate(time, timezone) {const p = zonedParts(time, timezone); return `${p.year}-${p.month}-${p.day}`;}
function shiftDate(date, days) {return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);}
function zonedEpoch(date, clock, timezone, ambiguity = 'earlier') {
  const iso = `${date}T${clock.length === 5 ? clock + ':00' : clock}`, naive = Date.parse(iso + 'Z'); if (!Number.isFinite(naive)) throw new TypeError('ISO date and HH:mm[:ss] required');
  const offsets = new Set();
  for (const d of [-1, 0, 1]) {const t = naive + d * 86400000, p = zonedParts(t, timezone), local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`); offsets.add(local - t);}
  const candidates = [...offsets].map(offset => naive - offset).filter(t => {const p = zonedParts(t, timezone); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === iso;}).sort((a, b) => a - b);
  if (!candidates.length) throw new RangeError('Nonexistent local time at DST boundary');
  if (candidates.length > 1 && ambiguity === 'reject') throw new RangeError('Ambiguous local time');
  return ambiguity === 'later' ? candidates[candidates.length - 1] : candidates[0];
}
function validateSymbol(symbol) {
  if (!symbol || ['id', 'exchange', 'timezone', 'currency', 'volumeUnit'].some(k => typeof symbol[k] !== 'string' || !symbol[k]) || !Number.isInteger(symbol.priceDecimals) || symbol.priceDecimals < 0 || symbol.priceDecimals > 18 || !Number.isFinite(symbol.tickSize) || symbol.tickSize <= 0 || !['raw', 'split', 'total-return'].includes(symbol.adjustment)) throw new TypeError('Invalid symbol metadata');
  zonedParts(0, symbol.timezone); return Object.freeze({...symbol});
}
function formatPrice(value, symbol) {return value.toFixed(symbol.priceDecimals);}
function normalizeOHLCV(rows, {timeUnit = 'ms', format = 'objects'} = {}) {
  if (!['ms', 's'].includes(timeUnit) || !['objects', 'tuples'].includes(format)) throw new TypeError('Explicit format/time unit required');
  return rows.map(row => {const b = Object.fromEntries(FIELDS.map((k, i) => {const value = format === 'tuples' ? row[i] : row[k]; if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) throw new TypeError('Numeric fields or nonempty numeric strings required'); return [k, Number(value)];})); if (timeUnit === 's') b.time *= 1000; validateBar(b); return b;});
}

/** Exact timestamp join onto an existing timeline. Unmatched values remain NaN.
 * Inputs are UTC integer milliseconds, strictly ordered, with no duplicate time.
 * This deliberately neither creates a union timeline nor carries values forward.
 */
function alignSeriesByTime(referenceTimes, points) {
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
class SessionCalendar {
  constructor(timezone, sessionsForDate, {maxCachedDays = 512} = {}) {if (typeof sessionsForDate !== 'function' || !Number.isInteger(maxCachedDays) || maxCachedDays < 1) throw new TypeError('Calendar provider and positive cache size required'); this.timezone = timezone; this.provider = sessionsForDate; this.cache = new Map(); this.maxCachedDays = maxCachedDays; zonedParts(0, timezone);calendarAnchors.set(this,new Map());}
  invalidate() {this.cache.clear();calendarAnchors.get(this).clear();}
  sessions(date) {
    if (!this.cache.has(date)) {
      const windows = this.provider(date).map(s => ({date, kind: s.kind ?? 'regular', open: zonedEpoch(date, s.open, this.timezone), close: zonedEpoch(s.close <= s.open ? shiftDate(date, 1) : date, s.close, this.timezone)}));
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
class TickAggregator {
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

function applyDataEvent(store, event) {
  if (!event || typeof event.kind !== 'string') throw new TypeError('Data event kind required');
  if (event.kind === 'batch') return store.applyEvents(event.events);
  if (event.kind === 'reset') event.columns ? store.setColumns(event.columns, event.length) : store.setData(event.bars);
  else if (event.kind === 'append') store.append(event.bar);
  else if (event.kind === 'update') {if (!store.length || event.bar.time !== store.columns.time[store.length - 1]) throw new RangeError('Update is only the current bar'); store.update(store.length - 1, event.bar);}
  else if (event.kind === 'correction') {const i = store.lowerBound(event.bar.time); if (i === store.length || store.columns.time[i] !== event.bar.time) throw new RangeError('Correction requires an existing timestamp'); store.update(i, event.bar);}
  else if (event.kind === 'prepend') store.prepend(event.bars); else throw new TypeError('Unknown data event');
}

const DEMO_SYMBOLS = {
  kr: {id: 'SYNTH:KR', exchange: 'SYNTH-KR', timezone: 'Asia/Seoul', currency: 'KRW', priceDecimals: 0, tickSize: 100, volumeUnit: 'shares', adjustment: 'raw'},
  us: {id: 'SYNTH:US', exchange: 'SYNTH-US', timezone: 'America/New_York', currency: 'USD', priceDecimals: 2, tickSize: .01, volumeUnit: 'shares', adjustment: 'raw'},
  crypto: {id: 'SYNTH:COIN', exchange: 'SYNTH-24/7', timezone: 'UTC', currency: 'USD', priceDecimals: 12, tickSize: 1e-12, volumeUnit: 'base-asset', adjustment: 'raw'}
};
function demoCalendar(market) {
  const symbol = DEMO_SYMBOLS[market]; if (!symbol) throw new Error('Unknown synthetic market');
  return new SessionCalendar(symbol.timezone, date => {
    if (market === 'crypto') return [{open: '00:00', close: '00:00', kind: 'regular'}];
    const weekday = new Date(date + 'T12:00:00Z').getUTCDay(); if ([0, 6].includes(weekday)) return [];
    return market === 'kr' ? [{open: '09:00', close: '15:30', kind: 'regular'}] : [{open: '04:00', close: '09:30', kind: 'extended'}, {open: '09:30', close: '16:00', kind: 'regular'}, {open: '16:00', close: '20:00', kind: 'extended'}];
  });
}

// Internal UTC-session representation shared by async capture and worker compute.
// No callbacks, local clocks or mutable calendar caches cross this boundary.
function resamplePlanRecord(value,keys,label){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' record required');const copy={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!keys.includes(key)||!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' own data fields required');copy[key]=d.value;}if(keys.some(key=>!Object.hasOwn(copy,key)))throw new TypeError(label+' missing field');return copy;}
function resamplePlanTime(value){if(!Number.isSafeInteger(value)||Math.abs(value)>8640000000000000)throw new RangeError('UTC session time');return value;}
function validateResamplePlan(value){
 const p=resamplePlanRecord(value,['schema','version','from','to','segments'],'UTC session plan');if(p.schema!=='aster.utc-sessions'||p.version!==1)throw new TypeError('UTC session plan protocol');resamplePlanTime(p.from);resamplePlanTime(p.to);if(p.to<p.from)throw new RangeError('UTC session plan bounds');
 if(!Array.isArray(p.segments)||p.segments.length>16384)throw new RangeError('UTC session segment limit');const count=p.segments.length,segments=[];let previous=-Infinity;
 for(let i=0;i<count;i++){const d=Object.getOwnPropertyDescriptor(p.segments,String(i));if(!d||!Object.hasOwn(d,'value'))throw new TypeError('UTC session dense data array');const s=resamplePlanRecord(d.value,['open','close','kind'],'UTC segment');resamplePlanTime(s.open);resamplePlanTime(s.close);if(s.close<=s.open||s.open<previous||typeof s.kind!=='string'||!s.kind.length||s.kind.length>128)throw new RangeError('Ordered nonoverlapping UTC segments');previous=s.close;segments.push(s);}
 return {...p,segments};
}
function resamplePlanResolver(value){const plan=validateResamplePlan(value);let active=null;return time=>{if(time<plan.from||time>=plan.to)throw new RangeError('Source time outside captured UTC range');if(active&&time>=active.open&&time<active.close)return active;let low=0,high=plan.segments.length;while(low<high){const mid=(low+high)>>>1;if(plan.segments[mid].open<=time)low=mid+1;else high=mid;}active=plan.segments[low-1];if(!active||time>=active.close)throw new RangeError('Source bar outside selected session');return active;};}


const RESAMPLE_BYTES=256*1024*1024,RESAMPLE_DATES=4096,RESAMPLE_SEGMENTS=64,RESAMPLE_TOTAL_SEGMENTS=16384;
const resampleTypedPrototype=Object.getPrototypeOf(Float64Array.prototype),resampleTypedLength=Object.getOwnPropertyDescriptor(resampleTypedPrototype,'length').get,resampleTypedBuffer=Object.getOwnPropertyDescriptor(resampleTypedPrototype,'buffer').get;
function resampleShared(value){return typeof SharedArrayBuffer!=='undefined'&&resampleTypedBuffer.call(value) instanceof SharedArrayBuffer;}
function resampleTime(value,label) {if(!Number.isSafeInteger(value)||Math.abs(value)>8640000000000000)throw new RangeError(label+': exact UTC milliseconds required');return value;}
function resampleBudget(bytes) {if(!Number.isSafeInteger(bytes)||bytes>RESAMPLE_BYTES)throw new RangeError('Resampling typed storage limit: 256 MiB');}
function resampleVector(value,length,label) {if(!(value instanceof Float64Array)||resampleTypedLength.call(value)<length||resampleShared(value))throw new TypeError(label+': non-shared Float64Array required');return value;}
function resampleCopy(vector,length,Type=Float64Array) {const copy=new Type(length);for(let i=0;i<length;i++)copy[i]=vector[i];return copy;}
function resampleCalendar(calendar,kinds) {
 if(!(calendar instanceof SessionCalendar))throw new TypeError('SessionCalendar required');
 const timezone=calendar.timezone,provider=calendar.provider,dates=new Map();let totalSegments=0;
 const local=new SessionCalendar(timezone,date=>{
  if(dates.size>=RESAMPLE_DATES)throw new RangeError('Resampling calendar date limit: 4096');
  const supplied=provider(date),segmentCount=Array.isArray(supplied)?supplied.length:-1;if(segmentCount<0||segmentCount>RESAMPLE_SEGMENTS)throw new RangeError('Resampling calendar segments limit: 64 per date');
  totalSegments+=segmentCount;if(totalSegments>RESAMPLE_TOTAL_SEGMENTS)throw new RangeError('Resampling total calendar segment limit: 16384');
  const windows=[];for(let i=0;i<segmentCount;i++){const s=supplied[i];if(!s||typeof s!=='object')throw new TypeError('Calendar segment required');const {open,close,kind='regular'}=s;if(typeof open!=='string'||typeof close!=='string'||typeof kind!=='string')throw new TypeError('Calendar segment strings required');windows.push({open,close,kind});}
  dates.set(date,true);return windows;
 },{maxCachedDays:RESAMPLE_DATES});
 let active=null;
 return time=>{
  if(active&&time>=active.open&&time<active.close)return active;
  const day=marketDate(time,timezone),windows=[];
  for(const date of [shiftDate(day,-1),day,shiftDate(day,1)])for(const s of local.sessions(date))if(kinds.has(s.kind))windows.push(s);
  windows.sort((a,b)=>a.open-b.open);
  for(let i=1;i<windows.length;i++)if(windows[i].open<windows[i-1].close)throw new RangeError('Overlapping selected calendar sessions');
  active=windows.find(s=>time>=s.open&&time<s.close)??null;
  if(!active)throw new RangeError('Source bar outside selected session');return active;
 };
}

function resampleOHLCV(input,options) {return resampleWithResolver(input,options,(calendar,selected)=>resampleCalendar(calendar,selected));}
// Internal worker entry: UTC plans have already been bounded and validated by
// the transport. This still validates the plan again before using its resolver.
function resampleFromSessions(input,options,plan) {return resampleWithResolver(input,options,()=>resamplePlanResolver(plan));}
function resampleWithResolver(input,options,resolveSessions) {
 if(!input||!options)throw new TypeError('Resampling input and explicit options required');
 const {columns,length}=input,{sourceIntervalMs:source,targetIntervalMs:target,calendar,kinds,asOf,partialTarget}=options;
 sizeLimit(length,RESOURCE_LIMITS.maxBars,'Resampling source length');resampleBudget(length*122);
 if(!Number.isSafeInteger(source)||source<1||source>86400000||!Number.isSafeInteger(target)||target<source||target>86400000||target%source!==0)throw new RangeError('Exact intraday intervals with target a source multiple required');
 resampleTime(asOf,'asOf');if(!['reject','omit','include-unconfirmed'].includes(partialTarget))throw new TypeError('Explicit partialTarget policy required');
 const kindCount=Array.isArray(kinds)?kinds.length:0;
 if(!kindCount||kindCount>RESAMPLE_SEGMENTS)throw new TypeError('Explicit bounded session kinds required');
 const selected=new Set(),snapshot={};for(let i=0;i<kindCount;i++){const kind=kinds[i];if(typeof kind!=='string'||!kind.length||kind.length>128)throw new TypeError('Explicit bounded session kinds required');selected.add(kind);}
 if(!columns||typeof columns!=='object')throw new TypeError('OHLCV columns required');
 // Capture before calling trusted calendar providers; later host edits cannot
 // change the values validated and aggregated by this operation.
 for(const field of FIELDS)snapshot[field]=resampleCopy(resampleVector(columns[field],length,field),length);
 const sessionAt=resolveSessions(calendar,selected),row={};let previous=-Infinity;
 for(let i=0;i<length;i++){
  for(const field of FIELDS)row[field]=snapshot[field][i];validateBar(row,previous);previous=row.time;
  const close=resampleTime(row.time+source,'Source close'),session=sessionAt(row.time),delta=row.time-session.open;
  if(delta%source!==0)throw new RangeError('Source time off session grid');
  const start=session.open+Math.floor(delta/target)*target,end=Math.min(session.close,start+target);
  resampleTime(start,'Target open');resampleTime(end,'Target close');
  if(close>session.close||close>end)throw new RangeError('Source bar crosses session or target boundary');
 }
 let output=null,count=0;
 function pass(write) {
  let group=null,index=0;
  const finish=()=>{
   if(!group)return;
   const complete=group.first===group.time&&group.last+source===group.end&&(group.end-group.time)%source===0&&group.to-group.from===(group.end-group.time)/source;
   if(!complete&&partialTarget==='reject')throw new RangeError('Incomplete target source coverage');
   if(complete||partialTarget==='include-unconfirmed'){
    if(write){for(const field of FIELDS)output.columns[field][index]=group[field];output.endTime[index]=group.end;output.availableAt[index]=complete?group.end:NaN;output.sourceFrom[index]=group.from;output.sourceTo[index]=group.to;output.complete[index]=Number(complete);output.confirmed[index]=Number(complete&&group.end<=asOf);}
    index++;
   }
  };
  for(let i=0;i<length;i++){
   const time=snapshot.time[i];if(time+source>asOf)break;
   const session=sessionAt(time),start=session.open+Math.floor((time-session.open)/target)*target,end=Math.min(session.close,start+target);
   if(!group||group.time!==start){finish();group={time:start,end,first:time,last:time,from:i,to:i+1,open:snapshot.open[i],high:snapshot.high[i],low:snapshot.low[i],close:snapshot.close[i],volume:snapshot.volume[i]};}
   else {group.high=Math.max(group.high,snapshot.high[i]);group.low=Math.min(group.low,snapshot.low[i]);group.close=snapshot.close[i];group.volume+=snapshot.volume[i];group.last=time;group.to=i+1;}
   if(!Number.isFinite(group.volume))throw new RangeError('Resampled volume overflow');
  }
  finish();return index;
 }
 count=pass(false);
 output={columns:Object.fromEntries(FIELDS.map(field=>[field,new Float64Array(count)])),length:count,endTime:new Float64Array(count),availableAt:new Float64Array(count),sourceFrom:new Uint32Array(count),sourceTo:new Uint32Array(count),complete:new Uint8Array(count),confirmed:new Uint8Array(count),sourceIntervalMs:source,targetIntervalMs:target,asOf};
 pass(true);return output;
}

function alignConfirmedByTime(decisionTimes,values,timing) {
 if(!timing||!(Array.isArray(decisionTimes)||decisionTimes instanceof Float64Array))throw new TypeError('Decision times and confirmation timing required');
 const decisionLength=Array.isArray(decisionTimes)?decisionTimes.length:resampleTypedLength.call(decisionTimes);
 if(decisionTimes instanceof Float64Array)resampleVector(decisionTimes,decisionLength,'Decision times');
 const {length,endTime,availableAt,complete,confirmed,asOf}=timing;
 sizeLimit(length,RESOURCE_LIMITS.maxBars,'Confirmation length');sizeLimit(decisionLength,RESOURCE_LIMITS.maxBars,'Decision length');resampleBudget(length*26+decisionLength*16);resampleTime(asOf,'asOf');
 resampleVector(values,length,'Values');if(resampleTypedLength.call(values)!==length)throw new RangeError('Values and timing length must match');
 resampleVector(endTime,length,'End times');resampleVector(availableAt,length,'Availability');
 if(!(complete instanceof Uint8Array)||!(confirmed instanceof Uint8Array)||resampleTypedLength.call(complete)!==length||resampleTypedLength.call(confirmed)!==length)throw new TypeError('Exact-length Uint8 confirmation flags required');
 if(resampleShared(complete)||resampleShared(confirmed))throw new TypeError('Non-shared confirmation flags required');
 const ends=resampleCopy(endTime,length),available=resampleCopy(availableAt,length),flags=resampleCopy(confirmed,length,Uint8Array),coverage=resampleCopy(complete,length,Uint8Array),data=resampleCopy(values,length),decisions=new Float64Array(decisionLength);
 let previous=-Infinity,previousAvailable=-Infinity;
 for(let i=0;i<length;i++){
  const end=resampleTime(ends[i],'End time'),at=available[i],value=data[i];if(end<=previous)throw new RangeError('Strictly increasing end times required');previous=end;
  if(coverage[i]>1||flags[i]>1||value===Infinity||value===-Infinity)throw new TypeError('Valid confirmation flags and finite or NaN values required');
  if(flags[i]){if(!coverage[i]||at!==end||at>asOf||at<=previousAvailable)throw new RangeError('Inconsistent confirmed availability');previousAvailable=at;}
  else if(!Number.isNaN(at))throw new RangeError('Unconfirmed availability must be NaN');
 }
 previous=-Infinity;
 for(let i=0;i<decisions.length;i++){const time=resampleTime(decisionTimes[i],'Decision time');if(time<=previous)throw new RangeError('Strictly increasing decision times required');decisions[i]=time;previous=time;}
 const result=new Float64Array(decisions.length);let cursor=0,last=NaN;
 for(let i=0;i<decisions.length;i++){while(cursor<length&&ends[cursor]<=decisions[i]){if(flags[cursor])last=data[cursor];cursor++;}result[i]=last;}
 return result;
}

// Parameters remain JSON primitives. The calendar field holds a separately
// validated declarative schedule, never a provider function or module source.
function validateIndicatorParams(params) {
 if(!params||typeof params!=='object')throw new TypeError('Indicator params');
 optionRecord(params,Object.keys(params),'Indicator params');
 const descriptors=Object.getOwnPropertyDescriptors(params),keys=Reflect.ownKeys(descriptors);
 if(keys.length>32)throw new TypeError('Indicator parameter count');
 for(const key of keys){
  const d=descriptors[key];if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Indicator parameter data properties');
  const v=d.value;if(typeof v==='number'? !Number.isFinite(v):typeof v!=='string'||v.length>(key==='calendar'?65536:256))throw new TypeError('Indicator parameter values');
 }
 return params;
}


const linkedIndicatorModules=new Map(),linkedIndicatorFactories=new Map(),linkedFactoryNames=new WeakMap();
class UnsupportedIndicatorError extends Error {
 constructor(name){super('Unsupported indicator module: '+String(name).slice(0,128)+'; requires a canonical builtin or linked factory');this.name='UnsupportedIndicatorError';this.code='UNSUPPORTED_INDICATOR_MODULE';}
}
function moduleInteger(value,label){if(!Number.isSafeInteger(value)||value<1)throw new TypeError('Indicator module '+label);}
function moduleToken(value,label){identifier(value,label);if(value.includes('@')||value.includes('/'))throw new TypeError('Indicator module '+label);return value;}
function moduleRecord(value,keys,label){optionRecord(value,keys,label);for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' data properties');}return value;}
function defineIndicatorModule(spec){
 moduleRecord(spec,['id','version','stateVersion','indicators'],'Indicator module');moduleToken(spec.id,'id');moduleInteger(spec.version,'version');moduleInteger(spec.stateVersion,'state version');
 const key=spec.id+'@'+spec.version;if(linkedIndicatorModules.has(key))throw new TypeError('Duplicate indicator module');
 const entries=moduleRecord(spec.indicators,Object.keys(spec.indicators??{}),'Indicator module exports'),names=Object.keys(entries);
 if(!names.length||names.length>128||linkedIndicatorFactories.size+names.length>128)throw new RangeError('Indicator module export count');
 const definitions=names.map(exportName=>{
  moduleToken(exportName,'export name');const name=key+'/'+exportName;identifier(name,'Canonical indicator name');
  const entry=moduleRecord(entries[exportName],['factory','validateCheckpoint','causal'],'Indicator module export');
  if(typeof entry.factory!=='function'||typeof entry.validateCheckpoint!=='function'||entry.causal!==true)throw new TypeError('Causal indicator factory and checkpoint validator required');
  const module=Object.freeze({id:spec.id,version:spec.version,stateVersion:spec.stateVersion,exportName,causal:true});
  return Object.freeze({name,factory:entry.factory,module,validateCheckpoint:entry.validateCheckpoint});
 });
 for(const entry of definitions){linkedIndicatorFactories.set(entry.name,entry);let names=linkedFactoryNames.get(entry.factory);if(!names){names=new Set();linkedFactoryNames.set(entry.factory,names);}names.add(entry.name);}
 const publicEntries=Object.freeze(definitions.map(({name,factory,module})=>Object.freeze({name,factory,module})));
 linkedIndicatorModules.set(key,publicEntries);return publicEntries;
}
function portableIndicatorFactory(name){return linkedIndicatorFactories.get(name)?.factory;}
function portableIndicatorFactories(){return new Map([...linkedIndicatorFactories].map(([name,entry])=>[name,entry.factory]));}
function indicatorModule(name){return linkedIndicatorFactories.get(name)?.module;}
function requirePortableIndicator(name,factory){const entry=linkedIndicatorFactories.get(name);if(!entry||entry.factory!==factory||!linkedFactoryNames.get(factory)?.has(name))throw new UnsupportedIndicatorError(name);return entry.module;}
function indicatorModuleDefinitions(id,version){moduleToken(id,'id');moduleInteger(version,'version');const definitions=linkedIndicatorModules.get(id+'@'+version);if(!definitions)throw new UnsupportedIndicatorError(id+'@'+version);return definitions;}
function validateIndicatorModuleBinding(name,descriptor){
 const expected=indicatorModule(name);if(!expected){if(descriptor!==undefined)throw new TypeError('Indicator module descriptor binding');return undefined;}
 moduleRecord(descriptor,['id','version','stateVersion','exportName','causal'],'Indicator module descriptor');
 if(Object.keys(descriptor).length!==5||Object.keys(expected).some(key=>descriptor[key]!==expected[key]))throw new TypeError('Indicator module descriptor binding');return expected;
}
function validateModuleCheckpoint(name,params,state,index){
 const entry=linkedIndicatorFactories.get(name);if(!entry)throw new UnsupportedIndicatorError(name);
 validateIndicatorParams(params);if(!Number.isSafeInteger(index)||index<0||index>4194304)throw new RangeError('Module checkpoint index');
 // The codec receives a detached state. It validates; it never repairs or
 // replaces the state that will be installed into the calculation instance.
 const text=safeCheckpointStringify(state),copy=safeCheckpointParse(text),before=safeCheckpointStringify(copy);
 const result=entry.validateCheckpoint(Object.freeze({...params}),copy,index);
 if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw new TypeError('Module checkpoint validator must be synchronous');}
 if(result===false||result!==undefined&&result!==true&&!Object.is(result,copy)||safeCheckpointStringify(copy)!==before)throw new TypeError('Module checkpoint validation failed or mutated state');return state;
}

// Static application code linked identically in the owner, worker and native
// resources. This is a close-direction volume proxy, not bid/ask volume delta.
defineIndicatorModule({id:'aster.volume-direction',version:1,stateVersion:1,indicators:{pressure:{causal:true,
 factory({factor=1,shift=0}={}) {
  if(!Number.isFinite(factor)||Math.abs(factor)>1||!Number.isInteger(shift)||Math.abs(shift)>10000)throw new RangeError('Volume-direction factor/shift');
  return {outputs:['signed','cumulative'],plotOffsets:{signed:shift,cumulative:shift},create(){let previous=NaN,cumulative=0;return {
   step(b){const signed=Number.isNaN(previous)?0:Math.sign(b.close-previous)*b.volume*factor;previous=b.close;cumulative+=signed;return [signed,cumulative];},
   snapshot(){return {previous,cumulative};},restore(s){previous=s.previous;cumulative=s.cumulative;}
  };}};
 },
 validateCheckpoint(_params,state,index){
  optionRecord(state,['previous','cumulative'],'Volume-direction checkpoint');
  if(Object.keys(state).length!==2||typeof state.previous!=='number'||!Number.isFinite(state.cumulative)||(index===0?!(Number.isNaN(state.previous)&&state.cumulative===0):!Number.isFinite(state.previous)))throw new TypeError('Volume-direction checkpoint');
  return state;
 }
}}});


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
function portableSessionCalendar(options){
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

function vwapDefinition(params={}){
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
function pivotsDefinition(params={}){
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
function validateSessionCheckpoint(name,params,state,index){
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
// SMA alone recovers nonfinite sums without changing the shared rolling state
// schema or normal-path addition order used by the other builtins.
function smaRoll(s,key,value,n){
 const previous=s[key],before=previous?.sum??0,expired=previous?.a.length===n?previous.a[previous.head]:0;
 const result=roll(s,key,value,n);if(!Number.isFinite(value))return result;
 const q=s[key];if(n===1){q.sum=value;return value;}
 const scale=Math.max(Math.abs(before),Math.abs(expired),Math.abs(value),Math.abs(value-expired));
 if(!Number.isFinite(q.sum)||scale>0&&Math.abs(q.sum)<=scale*Number.EPSILON*4*n){
  let sum=0;for(let j=0;j<q.a.length;j++)sum+=q.a[(q.head+j)%q.a.length];q.sum=sum;
 }
 const mean=q.a.length===n?q.sum/n:NaN;return Number.isFinite(mean)?mean:NaN;
}
// Compensated rolling sums preserve small contributions when dominant bars leave.
// Extreme magnitudes rebase in FIFO order; this is deliberately not scaled VWMA.
function vwmaAccumulate(pair,value) {
  if(!Number.isFinite(pair[0]))return;
  const previous=pair[0],next=previous+value;
  const correction=pair[1]+(Math.abs(previous)>=Math.abs(value)?(previous-next)+value:(value-next)+previous);
  if(!Number.isFinite(next)||!Number.isFinite(correction)||!Number.isFinite(next+correction)){pair[0]=NaN;pair[1]=0;}else{pair[0]=next;pair[1]=correction;}
}
function vwmaLarge(s){return [1,2].some(k=>!Number.isFinite(s.sums[k][0]+s.sums[k][1])||s.sums[k][0]+s.sums[k][1]>=Number.MAX_VALUE/4);}
function vwmaCompensationLarge(s,p){return s.sums.some((q,k)=>{const scale=s.sums[k][0]+s.sums[k][1];return Math.abs(q[1])>Math.max(Number.MIN_VALUE*32*p,Math.abs(scale)*Number.EPSILON*32*p);});}
function vwmaContribution(s,pair,sign){const [product,volume]=pair;vwmaAccumulate(s.sums[1],sign*volume);if(Number.isFinite(product)){vwmaAccumulate(s.sums[0],sign*product);vwmaAccumulate(s.sums[2],sign*Math.abs(product));}}
function vwmaRebase(s){s.sums=[[0,0],[0,0],[0,0]];for(let j=0;j<s.a.length;j++)vwmaContribution(s,s.a[(s.head+j)%s.a.length],1);}
function vwmaStep(s,b,i,p){
 const large=vwmaLarge(s),pair=[b.close*b.volume,b.volume];let dominant=false;
 if(s.a.length===p){const old=s.a[s.head];dominant=Math.abs(old[0])>0&&Math.abs(old[0])>=Math.abs(s.sums[0][0]+s.sums[0][1])/2||old[1]>0&&old[1]>=(s.sums[1][0]+s.sums[1][1])/2;vwmaContribution(s,old,-1);s.invalid-=Number(!Number.isFinite(old[0]));s.positive-=Number(old[1]>0);s.a[s.head]=pair;s.head=(s.head+1)%p;}else s.a.push(pair);
 vwmaContribution(s,pair,1);s.invalid+=Number(!Number.isFinite(pair[0]));s.positive+=Number(pair[1]>0);
 if(!s.positive)s.sums=[[0,0],[0,0],[0,0]];
 else if(dominant||large||vwmaLarge(s)||vwmaCompensationLarge(s,p)||(i+1)%p===0||s.sums.some(q=>!Number.isFinite(q[0]+q[1]))||s.sums[1][0]+s.sums[1][1]<=0||s.sums[2][0]+s.sums[2][1]<0)vwmaRebase(s);
 const numerator=s.sums[0][0]+s.sums[0][1],volume=s.sums[1][0]+s.sums[1][1],absolute=s.sums[2][0]+s.sums[2][1];
 if(s.a.length<p||s.invalid||!s.positive||!Number.isFinite(numerator)||!Number.isFinite(volume)||!Number.isFinite(absolute))return[NaN];
 const result=numerator/volume;return[Number.isFinite(result)?result:NaN];
}
function smooth(s, key, value, n, alpha) {
  const q = s[key] ??= {count: 0, sum: 0, value: NaN};
  if (!Number.isFinite(value)) { q.count = 0; q.sum = 0; q.value = NaN; return NaN; }
  if (q.count < n) { q.count++; q.sum += value; if (q.count === n) q.value = q.sum / n; }
  else q.value += alpha * (value - q.value);
  return q.value;
}
// EMA-only recovery: preserve the shared smoother and legacy checkpoint shape.
function emaRecover(s,key,value,n,alpha){
 if(n===1&&Number.isFinite(value)){const q=s[key]??={count:0,sum:0,value:NaN};q.count=1;q.sum=0;q.value=value===0?0:value;return q.value;}
 let q=s[key];
 if(Number.isFinite(value)&&q&&(q.count<n?!Number.isFinite(q.sum):!Number.isFinite(q.value))){q.count=0;q.sum=0;q.value=NaN;}
 const before=q&&q.count>=n?q.value:NaN,result=smooth(s,key,value,n,alpha);q=s[key];
 if(!Number.isFinite(value))return result;
 if(q.count>=n&&!Number.isFinite(result)&&Number.isFinite(before)){
  const recovered=(1-alpha)*before+alpha*value;
  if(Number.isFinite(recovered)){q.value=recovered;return recovered;}
 }
 if(q.count<n&&!Number.isFinite(q.sum)||q.count>=n&&!Number.isFinite(q.value)){
  q.count=1;q.sum=value;q.value=n===1?value:NaN;return q.value;
 }
 return result;
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
const builtinIndicators = new Map();
// Private provenance follows definitions across local staging/hydration without
// trusting a mutable registry name. Weak keys do not retain retired studies.
const canonicalDefinitionOrigins=new WeakMap();
function add(name, make) {builtinIndicators.set(name,params=>{const def=make(params);canonicalDefinitionOrigins.set(def,{name,create:def.create,outputs:[...def.outputs],offsets:{...def.plotOffsets}});return def;});}
function isCanonicalBuiltinDefinition(name,def){
 const origin=canonicalDefinitionOrigins.get(def);if(!origin||origin.name!==name)return false;
 const own=(object,key)=>{const d=Object.getOwnPropertyDescriptor(object,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;},outputs=own(def,'outputs'),offsets=own(def,'plotOffsets');
 if(own(def,'create')!==origin.create||!Array.isArray(outputs)||own(outputs,'length')!==origin.outputs.length||origin.outputs.some((key,i)=>own(outputs,String(i))!==key))return false;
 if(!offsets||![Object.prototype,null].includes(Object.getPrototypeOf(offsets))||Reflect.ownKeys(offsets).length!==Object.keys(origin.offsets).length)return false;
 return Object.keys(origin.offsets).every(key=>Object.is(own(offsets,key),origin.offsets[key]));
}
add('sma', ({period: p = 20, source = 'close'} = {}) => {period(p); return definition(['value'], {}, (s, b) => [smaRoll(s, 'r', b[source], p)]);});
add('vwma', ({period:p=20}={})=>{period(p);return definition(['value'],{a:[],head:0,sums:[[0,0],[0,0],[0,0]],invalid:0,positive:0},(s,b,i)=>vwmaStep(s,b,i,p));});
add('ema', ({period: p = 20, source = 'close'} = {}) => {period(p); return definition(['value'], {}, (s, b) => [emaRecover(s, 'e', b[source], p, 2 / (p + 1))]);});
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
function resolveIndicatorFactory(name){return canonicalBuiltinIndicators.get(name)??portableIndicatorFactory(name);}
function requirePortableFactory(name,factory){const builtin=canonicalBuiltinIndicators.get(name);if(builtin&&factory===builtin)return null;return requirePortableIndicator(name,factory);}
// Running calls reject recursion; a suspended generator may be superseded by
// a new explicit calculation without leaving an abandoned iterator busy forever.
const indicatorCalculationGeneration=new WeakMap(),indicatorCalculationRunning=new WeakMap();
let indicatorCalculationDepth=0;
const MAX_INDICATOR_CALCULATION_DEPTH=32;
function acquireIndicatorCalculation(entry,token){if(indicatorCalculationDepth>=MAX_INDICATOR_CALCULATION_DEPTH)throw indicatorCalculationError('IndicatorBusyError','Indicator calculation nesting limit (32)');indicatorCalculationRunning.set(entry,token);indicatorCalculationDepth++;}
function releaseIndicatorCalculation(entry,token){if(indicatorCalculationRunning.get(entry)===token){indicatorCalculationRunning.delete(entry);indicatorCalculationDepth--;}}
function indicatorCalculationError(name,message){const error=new Error(message);error.name=name;return error;}
class IndicatorEngine {
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

// Shared structural validation; callers retain their existing copy/commit policy.
const DRAWING_TYPES = ['trendline', 'horizontal', 'fibonacci', 'rectangle', 'ellipse', 'text', 'ray', 'extendedline', 'channel', 'fibextension', 'fibfan', 'fibtimezones', 'freehand', 'measurement'];
function drawingPointCount(type) {return ['horizontal','text'].includes(type)?1:['channel','fibextension'].includes(type)?3:2;}
function validateDrawing(d) {
  optionRecord(d,['id','type','panel','points','style','text','locked','axisId','seriesId'],'Drawing');identifier(d.id,'Drawing id');identifier(d.panel,'Drawing panel');for(const key of ['axisId','seriesId'])if(d[key]!==undefined&&d[key]!==null)identifier(d[key],'Drawing '+key);
  if(!DRAWING_TYPES.includes(d.type))throw new TypeError('Drawing type');const count=drawingPointCount(d.type);
  if(!Array.isArray(d.points)||(d.type==='freehand'?d.points.length<2||d.points.length>2048:d.points.length!==count))throw new TypeError('Drawing anchors');
  for(const point of d.points){optionRecord(point,['time','price'],'Anchor');if(!Number.isFinite(point.time)||Math.abs(point.time)>8640000000000000||!Number.isFinite(point.price))throw new TypeError('Anchor time/price must be finite and within Date range');}
  if(d.text!==undefined)boundedText(d.text,2000,'Drawing text',true);if(d.locked!==undefined&&typeof d.locked!=='boolean')throw new TypeError('Locked must be boolean');
  if(d.style!==undefined){optionRecord(d.style,['color','fill','width','font'],'Drawing style');if(d.style.width!==undefined&&(!Number.isFinite(d.style.width)||d.style.width<.1||d.style.width>50))throw new RangeError('Stroke width');for(const key of ['color','fill'])if(d.style[key]!==undefined)boundedText(d.style[key],128,'Color');if(d.style.font!==undefined)portableFont(d.style.font);}
}

const copyDrawing = x => JSON.parse(JSON.stringify(x, (key,value)=>['axisId','seriesId'].includes(key)&&value===null?undefined:value));

const frozenDrawing=d=>{for(const point of d.points)Object.freeze(point);Object.freeze(d.points);if(d.style)Object.freeze(d.style);return Object.freeze(d);};
const drawingWeights=new WeakMap();
function drawingWeight(d){let weight=drawingWeights.get(d);if(weight===undefined){weight=JSON.stringify(d).length*2;drawingWeights.set(d,weight);}return weight;}
class DrawingStore {
  constructor({historyLimit=100,maxDrawings=RESOURCE_LIMITS.maxDrawings,maxPoints=RESOURCE_LIMITS.maxDrawingPoints,maxDocumentChars=RESOURCE_LIMITS.maxDocumentChars,historyBytes=RESOURCE_LIMITS.maxHistoryBytes}={}) {
    if(!Number.isInteger(historyLimit)||historyLimit<1||historyLimit>10000)throw new RangeError('History limit 1..10000');for(const [name,value] of Object.entries({maxDrawings,maxPoints,maxDocumentChars,historyBytes}))sizeLimit(value,name==='maxPoints'?2097152:name==='maxDocumentChars'?RESOURCE_LIMITS.maxDocumentChars: name==='maxDrawings'?10000:RESOURCE_LIMITS.maxHistoryBytes,name);
    Object.assign(this,{maxDrawings,maxPoints,maxDocumentChars,historyBytes,historyLimit});this.items=[];this.undoStack=[];this.redoStack=[];this.selected=null;this.transaction=null;this.serial=0;this.historyWeights=new WeakMap();
  }
  snapshot(){return copyDrawing(this.items);}
  budget(items){if(items.length>this.maxDrawings)throw new RangeError('Drawing count limit');let points=0,text=0;for(const d of items){points+=d.points.length;text+=d.text?.length??0;}if(points>this.maxPoints||text>1000000)throw new RangeError('Drawing points/text limit');}
  weight(snapshot){let value=this.historyWeights.get(snapshot);if(value===undefined){value=snapshot.length*8+snapshot.reduce((n,d)=>n+drawingWeight(d),0);this.historyWeights.set(snapshot,value);}return value;}
  trim(){let bytes=[...this.undoStack,...this.redoStack].reduce((n,s)=>n+this.weight(s),0);while(this.undoStack.length>this.historyLimit||bytes>this.historyBytes){const old=this.undoStack.length?this.undoStack.shift():this.redoStack.shift();if(!old)break;bytes-=this.weight(old);}this.retainedHistoryBytes=bytes;}
  begin(){if(this.transaction)throw new Error('A drawing transaction is already active');this.transaction=this.items.slice();}
  commit(){if(!this.transaction)return;const before=this.transaction;this.transaction=null;if(before.length!==this.items.length||before.some((d,i)=>d!==this.items[i])){this.undoStack.push(before);this.redoStack=[];this.trim();}}
  cancel(){if(this.transaction){this.items=this.transaction.slice();this.transaction=null;if(!this.items.some(x=>x.id===this.selected))this.selected=null;}}
  mutate(fn){const own=!this.transaction;if(own)this.begin();try{fn();if(own)this.commit();}catch(error){if(own)this.cancel();throw error;}}
  // ChartAPI may preflight against the committed snapshot, then cancel pointer
  // ownership only after validation succeeds. Pointer/manual callers use the
  // default current items and retain their existing transaction grouping.
  // Validate the JSON-normalized copy too: nested getters/toJSON may change
  // values after the initial caller-shape check but before publication.
  add(input,{items=this.items,beforeMutation=null}={}){optionRecord(input,['id','type','panel','points','style','text','locked','axisId','seriesId'],'Drawing');let id=input.id,serial=this.serial;if(!id){do{id=`drawing-${++serial}`;}while(items.some(d=>d.id===id));}const d={id,panel:'price',locked:false,style:{color:'#f5b85a',width:1.5},...input,id};validateDrawing(d);const copy=copyDrawing(d);validateDrawing(copy);frozenDrawing(copy);if(items.some(x=>x.id===id))throw new Error('Duplicate drawing id');const next=[...items,copy];this.budget(next);beforeMutation?.();this.mutate(()=>{this.items=next;});this.serial=serial;this.selected=id;return id;}
  edit(id,patch,{items=this.items,beforeMutation=null}={}){optionRecord(patch,['type','panel','points','style','text','locked','axisId','seriesId'],'Drawing patch');const i=items.findIndex(x=>x.id===id);if(i<0)throw new Error('Missing drawing');const previous=items[i];if(previous.locked&&Object.keys(patch).some(k=>k!=='locked'))throw new Error('Drawing is locked');const next={...previous,...patch};validateDrawing(next);if(JSON.stringify(previous)===JSON.stringify(next)){beforeMutation?.();return;}const copy=copyDrawing(next);validateDrawing(copy);frozenDrawing(copy);const changed=items.slice();changed[i]=copy;this.budget(changed);beforeMutation?.();this.mutate(()=>{this.items=changed;});}
  remove(id,{items=this.items,beforeMutation=null}={}){const d=items.find(x=>x.id===id);if(!d||d.locked)return false;const next=items.filter(x=>x.id!==id);beforeMutation?.();this.mutate(()=>{this.items=next;});if(this.selected===id)this.selected=null;return true;}
  undo(){if(this.transaction)this.cancel();if(!this.undoStack.length)return false;this.redoStack.push(this.items.slice());this.items=this.undoStack.pop().slice();this.selected=null;this.trim();return true;}
  redo(){if(this.transaction)this.cancel();if(!this.redoStack.length)return false;this.undoStack.push(this.items.slice());this.items=this.redoStack.pop().slice();this.selected=null;this.trim();return true;}
  save(){if(this.transaction)throw new Error('Commit or cancel before saving');return boundedText(JSON.stringify({schema:'aster.drawings',version:this.items.some(d=>d.axisId!=null||d.seriesId!=null)?2:1,drawings:this.items}),this.maxDocumentChars,'Drawing document',true);}
  load(text,{styleDecoder=null,validatePanel=null,validateBinding=null}={}) {
    boundedText(text,this.maxDocumentChars,'Drawing document',true);const doc=JSON.parse(text);optionRecord(doc,['schema','version','drawings'],'Drawing document');if(doc.schema!=='aster.drawings'||![1,2].includes(doc.version)||!Array.isArray(doc.drawings)||doc.drawings.length>this.maxDrawings)throw new TypeError('Unsupported drawing document');
    const items=doc.drawings.map(d=>{validateDrawing(d);if(doc.version===1&&(d.axisId!=null||d.seriesId!=null))throw new TypeError('Bound drawings require document version 2');if(validateBinding&&!validateBinding(d))throw new Error('Invalid drawing binding');if(validatePanel&&!validatePanel(d.panel))throw new Error('Missing drawing panel');const next=copyDrawing(d);if(styleDecoder&&next.style)next.style=styleDecoder(next.style);validateDrawing(next);return frozenDrawing(next);});this.budget(items);if(new Set(items.map(d=>d.id)).size!==items.length)throw new TypeError('Duplicate drawing ids');if(this.transaction)throw new Error('Cannot load during a gesture');this.mutate(()=>{this.items=items;});this.selected=null;
  }
}

function segmentDistance(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
}
function extendedSegment(a,b,p,ray=false) {
 const dx=b.x-a.x,dy=b.y-a.y;if(!dx&&!dy)return [];
 let lo=ray?0:-Infinity,hi=Infinity;
 for(const [origin,delta,min,max] of [[a.x,dx,p.left,p.right],[a.y,dy,p.top,p.bottom]]){if(!delta){if(origin<min||origin>max)return [];}else{const t=(min-origin)/delta,z=(max-origin)/delta;lo=Math.max(lo,Math.min(t,z));hi=Math.min(hi,Math.max(t,z));}}
 return lo<=hi?[a.x+dx*lo,a.y+dy*lo,a.x+dx*hi,a.y+dy*hi]:[];
}
// One geometry definition drives all renderers and hit testing. Fibonacci price
// levels interpolate raw price, then apply the panel transform (including log).
function calculateGeometry(d,layout) {
 const p=layout.drawingAxis?layout.drawingAxis(d):layout.panels.find(p=>p.id===d.panel);if(!p)return [];
 const points=d.points.map(q=>layout.toScreen(q,d.panel,d.axisId));if(points.some(q=>!Number.isFinite(q.x)||!Number.isFinite(q.y)))return [];
 const [a,b=a,c=b]=points,commands=[],color=d.style?.color??'#f5b85a',width=d.style?.width??1.5,clip=[p.left,p.top,p.right-p.left,p.bottom-p.top];
 const line=(coords,dash=null)=>{if(coords.length)commands.push({op:'lines',coords,color,width,clip,dash});},label=(x,y,text)=>commands.push({op:'text',x,y,text,color,font:'12px monospace',clip});
 if(d.type==='horizontal')line([p.left,a.y,p.right,a.y]);
 else if(['trendline','measurement'].includes(d.type)){line([a.x,a.y,b.x,b.y]);if(d.type==='measurement'){const delta=d.points[1].price-d.points[0].price,percent=d.points[0].price===0?'n/a':(delta/d.points[0].price*100).toFixed(2)+'%',bars=layout.index(b.x)-layout.index(a.x),seconds=(d.points[1].time-d.points[0].time)/1000;label((a.x+b.x)/2,Math.min(a.y,b.y)-8,`Δ ${delta.toPrecision(6)} (${percent}) · ${bars.toFixed(1)} bars · ${seconds.toFixed(0)}s`);}}
 else if(d.type==='ray'||d.type==='extendedline')line(extendedSegment(a,b,p,d.type==='ray'));
 else if(d.type==='channel'){line(extendedSegment(a,b,p));line(extendedSegment(c,{x:c.x+b.x-a.x,y:c.y+b.y-a.y},p));line(extendedSegment({x:(a.x+c.x)/2,y:(a.y+c.y)/2},{x:(a.x+c.x)/2+b.x-a.x,y:(a.y+c.y)/2+b.y-a.y},p),[4,4]);}
 else if(d.type==='fibonacci'||d.type==='fibextension'){
  const ratios=d.type==='fibonacci'?[0,.236,.382,.5,.618,.786,1]:[0,.618,1,1.272,1.618,2.618];
  for(const r of ratios){const price=d.type==='fibonacci'?d.points[0].price+(d.points[1].price-d.points[0].price)*r:d.points[2].price+(d.points[1].price-d.points[0].price)*r,y=p.y(price);if(!Number.isFinite(y))continue;line([a.x,y,d.type==='fibextension'?p.right:b.x,y]);label(Math.min(a.x,b.x)+4,y-3,`${(r*100).toFixed(1)}%`);}
 }else if(d.type==='fibfan'){for(const r of [.382,.5,.618]){const target={x:b.x,y:p.y(d.points[0].price+(d.points[1].price-d.points[0].price)*r)};if(Number.isFinite(target.y))line(extendedSegment(a,target,p,true));}label(a.x,a.y-8,'38.2 / 50 / 61.8');}
 else if(d.type==='fibtimezones'){for(const r of [0,1,2,3,5,8,13,21,34]){const x=a.x+(b.x-a.x)*r;line([x,p.top,x,p.bottom]);label(x+3,p.top+28,String(r));}}
 else if(d.type==='freehand'){const coords=[];for(let i=1;i<points.length;i++)coords.push(points[i-1].x,points[i-1].y,points[i].x,points[i].y);line(coords);}
 else if(d.type==='text')label(a.x,a.y,d.text??'Note');
 else commands.push({op:d.type==='rectangle'?'box':'ellipse',x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y),color,width,fill:d.style?.fill,clip});
 return commands;
}
const geometryCache=new WeakMap(),boundsCache=new WeakMap();
function drawingGeometry(d,layout) {
 const cached=geometryCache.get(d);if(layout.geometryKey&&cached?.key===layout.geometryKey)return cached.commands;
 const commands=calculateGeometry(d,layout);
 if(layout.geometryKey&&Object.isFrozen(d)){for(const c of commands){if(c.coords)Object.freeze(c.coords);if(c.clip)Object.freeze(c.clip);Object.freeze(c);}Object.freeze(commands);geometryCache.set(d,{key:layout.geometryKey,commands});}return commands;
}
function candidateBounds(d,layout,x,y,tolerance) {
 if(!['freehand','trendline','rectangle','ellipse','text','measurement'].includes(d.type))return true;
 let bounds=boundsCache.get(d);if(!bounds){let timeMin=Infinity,timeMax=-Infinity,priceMin=Infinity,priceMax=-Infinity;for(const p of d.points){timeMin=Math.min(timeMin,p.time);timeMax=Math.max(timeMax,p.time);priceMin=Math.min(priceMin,p.price);priceMax=Math.max(priceMax,p.price);}bounds={timeMin,timeMax,priceMin,priceMax};if(Object.isFrozen(d))boundsCache.set(d,bounds);}
 const a=layout.toScreen({time:bounds.timeMin,price:bounds.priceMin},d.panel,d.axisId),b=layout.toScreen({time:bounds.timeMax,price:bounds.priceMax},d.panel,d.axisId);
 const fontSize=Number((d.style?.font??layout.geometryFont??'12px monospace').match(/([0-9.]+)px/)?.[1]??12),textWidth=d.type==='text'?(d.text?.length??4)*fontSize*1.2:0,labelHeight=['text','measurement'].includes(d.type)?fontSize*2:0;
 return x>=Math.min(a.x,b.x)-tolerance&&x<=Math.max(a.x,b.x)+tolerance+textWidth&&y>=Math.min(a.y,b.y)-tolerance-labelHeight&&y<=Math.max(a.y,b.y)+tolerance+labelHeight;
}
function drawingHitTest(store, layout, x, y, tolerance = 8) {
  if(!Number.isFinite(tolerance)||tolerance<1||tolerance>32)throw new RangeError('Drawing hit tolerance must be 1..32 logical pixels');
  const panel = layout.panels.find(p => y >= p.top && y <= p.bottom && x >= p.left && x <= p.right); if (!panel) return null;
  // Selected handles precede other geometry; otherwise latest drawing wins.
  const ordered = [...store.items].reverse(); const selected = ordered.find(d => d.id === store.selected);
  if (selected && (!layout.drawingAxis||layout.drawingAxis(selected)) && !selected.locked && selected.panel === panel.id) {
    const points = selected.points.map(p => layout.toScreen(p, panel.id,selected.axisId));
    let handle=-1,distance=Infinity;for(let i=0;i<points.length;i++){const d=Math.hypot(points[i].x-x,points[i].y-y);if(d<=tolerance&&d<distance){handle=i;distance=d;}}if(handle>=0)return {id:selected.id,handle};
  }
  for (const d of ordered) {
    if((layout.drawingAxis&&!layout.drawingAxis(d))||d.panel!==panel.id||!candidateBounds(d,layout,x,y,tolerance))continue; const a = layout.toScreen(d.points[0], d.panel,d.axisId), b = d.points[1] ? layout.toScreen(d.points[1], d.panel,d.axisId) : a;
    let hit = false;
    if (d.type === 'horizontal') hit = Math.abs(y - a.y) <= tolerance;
    else if(d.type==='text'){const metrics=labelMetrics(d.style?.font??layout.geometryFont??'12px monospace');hit=x>=a.x-tolerance&&x<=a.x+labelWidth(d.text??'Note',metrics)+tolerance&&y>=a.y-metrics.ascent-tolerance&&y<=a.y+metrics.descent+tolerance;}
    else if (!['rectangle','ellipse'].includes(d.type)) {for(const c of drawingGeometry(d,layout))if(c.op==='lines'){for(let i=0;i<c.coords.length;i+=4)if(segmentDistance(x,y,{x:c.coords[i],y:c.coords[i+1]},{x:c.coords[i+2],y:c.coords[i+3]})<=tolerance){hit=true;break;}if(hit)break;}}
    else if (d.type === 'rectangle') {const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x), t = Math.min(a.y, b.y), z = Math.max(a.y, b.y); hit = x >= l - tolerance && x <= r + tolerance && y >= t - tolerance && y <= z + tolerance && Math.min(Math.abs(x - l), Math.abs(x - r), Math.abs(y - t), Math.abs(y - z)) <= tolerance;}
    else {const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2; if (rx && ry) hit = Math.abs(Math.hypot((x - (a.x + b.x) / 2) / rx, (y - (a.y + b.y) / 2) / ry) - 1) * Math.min(rx, ry) <= tolerance;}
    if (hit) return {id: d.id, handle: -1, locked: !!d.locked};
  }
  return null;
}


// Internal display-list parts shared by full/native scenes and browser layers.
// They take the same layout, so overlay coordinates and price units cannot drift.
function formatAxisValue(model, axis, value) {
  const precision=axis.precision??(axis.scale==='percent'?2:model.precision);
  if(axis.formatter)return boundedText(String(axis.formatter(value)),256,'Axis formatter output',true);
  if(axis.axisId==null&&axis.scale!=='percent'&&model.priceFormatter&&axis.id==='price')return boundedText(String(model.priceFormatter(value)),256,'Price formatter output',true);
  const n=axis.scale==='percent'?axis.transform(value):value;
  return (axis.prefix??'')+(axis.tickFormat==='scientific'?n.toExponential(precision):n.toFixed(precision))+(axis.scale==='percent'?'%':'')+(axis.suffix??'');
}

function aggregateVolumeSeries(series) {
  return series.type === 'histogram' && series.source === 'volume' && !series.values && !series.indicator && (series.offset ?? 0) === 0 && (series.baseline ?? 0) === 0;
}

function createDrawingCommands(model, layout) {
  const commands = [], theme = model.theme;
  for (const drawing of model.drawings.items) {
    const panel = layout.drawingAxis(drawing);
    if (!panel) continue;
    const a = layout.toScreen(drawing.points[0], drawing.panel,drawing.axisId), b = drawing.points[1] ? layout.toScreen(drawing.points[1], drawing.panel,drawing.axisId) : a;
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
    const color = drawing.style?.color ?? '#f5b85a', clip = [panel.left, panel.top, panel.right - panel.left, panel.bottom - panel.top];
    for (const command of drawingGeometry(drawing, layout)) commands.push(command.op === 'text' ? {...command, font: drawing.style?.font ?? theme.font} : command);
    if (drawing.id === model.drawings.selected) for (const point of drawing.points) {
      const p = layout.toScreen(point, drawing.panel,drawing.axisId);
      commands.push({op: 'box', x: p.x - 4, y: p.y - 4, w: 8, h: 8, fill: drawing.locked ? theme.text : theme.background, color, width: 1, clip});
    }
  }
  return commands;
}

function createCrosshairCommands(model, layout) {
  const cursor = model.crosshair, commands = [], theme = model.theme;
  if (!cursor || !model.store.length) return commands;
  const {x, y} = cursor, panel = layout.panels.find(p => y >= p.top && y <= p.bottom && x >= p.left && x <= p.right);
  if (!panel) return commands;
  for (const p of layout.panels) commands.push({op: 'lines', coords: [x, p.top, x, p.bottom], color: theme.crosshair, width: 1, clip: null, dash: [4, 4]});
  commands.push({op: 'lines', coords: [panel.left, y, panel.right, y], color: theme.crosshair, width: 1, clip: null, dash: [4, 4]});
  const metrics=labelMetrics(theme.font),background=portableColor(theme.background).slice(0,7)+'ff';
  if(panel.bottom-panel.top>=metrics.height+8)for(const axis of panel.axes.filter(a=>a.visible)){
    const clip=[axis.axisLeft,panel.top,axis.axisRight-axis.axisLeft,panel.bottom-panel.top],top=Math.max(panel.top+4,Math.min(panel.bottom-metrics.height-4,y-metrics.height/2)),command=labelCommand(formatAxisValue(model,axis,axis.price(y)),axis.axisLeft+4,top+metrics.ascent,axis.axisRight-axis.axisLeft-8,theme.font,theme.crosshair,clip,{role:'crosshair-price',panelId:panel.id,axisId:axis.axisId});
    if(command){commands.push({op:'box',x:axis.axisLeft,y:top-4,w:axis.axisRight-axis.axisLeft,h:metrics.height+8,fill:background,color:background,width:0,clip});commands.push(command);}
  }
  return commands;
}

// Shared readout keeps native cached hover on the already prepared layout.
function crosshairValuesAt(model,layout){
  const c=model.crosshair;if(!c||!model.store.length)return null;const p=layout.panels.find(p=>c.x>=p.left&&c.x<=p.right&&c.y>=p.top&&c.y<=p.bottom);if(!p)return null;
  const index=Math.round(layout.index(c.x));if(index<0||index>=model.store.length)return null;const store=model.store;
  return {index,time:store.columns.time[index],primary:{symbolId:model.symbol?.id??null,bar:store.at(index)},series:model.series.filter(s=>s.visible!==false).map(s=>{const sourceIndex=index-(s.offset??0),array=s.values??(s.indicator?model.indicators.get(s.indicator).outputs[s.output??Object.keys(model.indicators.get(s.indicator).outputs)[0]]:store.columns[s.source??'close']),value=sourceIndex>=0&&sourceIndex<store.length?array[sourceIndex]:NaN,finite=Number.isFinite(value);return {id:s.id,label:s.label??s.id,symbolId:s.values?s.symbolId??null:model.symbol?.id??null,panel:s.panel,axisId:s.axisId??null,value:finite?value:null,sourceIndex,sourceTime:finite?store.columns.time[sourceIndex]:null};}),axes:p.axes.map(a=>({id:a.axisId,panel:p.id,value:a.price(c.y),formatted:formatAxisValue(model,a,a.price(c.y))}))};
}


// Keep small-series flat queries; large series use the existing32-value blocks.
// This is shared with background preparation so ready caches need no conversion.
const SERIES_BLOCK_THRESHOLD = 65536;

function axisStripWidths(panels,axes,axisWidth){
  let left=0,right=0;
  for(const panel of panels){let rowLeft=0,rowRight=0;if(panel.axisVisible!==false){if(panel.axisSide==='left')rowLeft=axisWidth;else rowRight=axisWidth;}
    for(const axis of axes)if(axis.panel===panel.id&&axis.visible){if(axis.side==='left')rowLeft+=axis.width??axisWidth;else rowRight+=axis.width??axisWidth;}
    left=Math.max(left,rowLeft);right=Math.max(right,rowRight);
  }
  return [left,right];
}

const DARK_THEME = {background: '#0c1320', grid: '#1d2a3a', text: '#8093ad', up: '#35d2ab', down: '#fa6c7c', crosshair: '#b9c9de', font: '12px monospace'};
const LIGHT_THEME = {background: '#f8fafc', grid: '#dfe6ee', text: '#53657d', up: '#078d6d', down: '#df344b', crosshair: '#304158', font: '12px monospace'};
class ChartModel {
  constructor({store = new BarStore(), theme = DARK_THEME, panels = [{id: 'price', weight: 3}], axes = [], visibleBars = 200, axisWidth = 82, precision = 2} = {}) {
    if (!panels.length || !Number.isFinite(axisWidth) || axisWidth < 20 || !Number.isFinite(visibleBars) || visibleBars < 1 || !Number.isInteger(precision) || precision < 0 || precision > 18) throw new RangeError('Panels, width, visible bars or precision');
    if(!(store instanceof BarStore))throw new TypeError('BarStore required');optionRecord(theme,THEME_KEYS,'Theme');for(const value of Object.values(theme))boundedText(value,256,'Theme value');
    this.store = store; this.theme = {...DARK_THEME, ...theme}; this.panels = []; this.axes = []; this.series = []; this.seriesValueRevisions = new WeakMap(); this.axisWidth = axisWidth; this.precision = precision;
    this.view = {from: Math.max(-.5, store.length - visibleBars - .5), to: Math.max(visibleBars - .5, store.length - .5)}; this.crosshair = null; this.follow = true;
    panels.forEach(p => this.addPanel(p));if(!Array.isArray(axes))throw new TypeError('Axes array required');axes.forEach(a=>this.addAxis(a));this.indicators=new IndicatorEngine(store);try{this.drawings=new DrawingStore(); this.unsubscribe = store._subscribeInternal(({kind, from, added, appended}) => {if(kind==='compact')return;if (kind === 'prepend') {this.view.from += added; this.view.to += added;} else if (kind === 'reset') this.fit(); if ((kind === 'append'||kind==='batch'&&appended>0) && this.follow) {const span = this.view.to - this.view.from; this.view.to = store.length + this.forwardOffset() - .5; this.view.from = this.view.to - span;} for (const s of this.series) s.dirtyFrom = Math.min(s.dirtyFrom ?? Infinity, from);});registerStoreOwner(this,store,'model');}catch(error){try{this.indicators.dispose();}catch{}throw error;}
  }
  addPanel(options) {optionRecord(options,PANEL_KEYS,'Panel');identifier(options.id,'Panel id');if(this.panels.length>=RESOURCE_LIMITS.maxPanels)throw new RangeError('Panel limit');if (!options?.id || this.panels.some(p => p.id === options.id) || !Number.isFinite(options.weight ?? 1) || (options.weight ?? 1) <= 0) throw new Error('Unique panel id and positive weight'); const p = {weight: 1, scale: 'linear', inverted: false, padding: .08, ...options}; this.validatePanel(p);if(this.drawings?.transaction)throw new Error('Panel layout change during drawing transaction'); this.panels.push(p); return p.id;}
  validatePanel(p) {if(p.axisVisible!==undefined&&typeof p.axisVisible!=='boolean'||p.axisSide!==undefined&&!['left','right'].includes(p.axisSide))throw new TypeError('Panel axis visibility/side');if(typeof p.inverted!=='boolean'||p.label!==undefined&&typeof p.label!=='string'||p.formatter!==undefined&&typeof p.formatter!=='function'||p.range&&(!Array.isArray(p.range)||p.range.length!==2))throw new TypeError('Panel label, inverted, formatter or range');if(p.label!==undefined)boundedText(p.label,256,'Panel label');if (!Number.isFinite(p.weight) || p.weight <= 0 || p.base !== undefined && !Number.isFinite(p.base) || !['linear', 'log', 'percent'].includes(p.scale) || !Number.isFinite(p.padding) || p.padding < 0 || p.padding > 1 || p.precision !== undefined && (!Number.isInteger(p.precision) || p.precision < 0 || p.precision > 18) || (p.range && (!Number.isFinite(p.range[0]) || !Number.isFinite(p.range[1]) || p.range[0] >= p.range[1] || p.scale === 'log' && p.range[0] <= 0)) || p.scale === 'percent' && p.base === 0) throw new RangeError('Panel scale/range');}
  drawingProjectionChange(previous,next,keys){return keys.some(key=>Array.isArray(previous[key])&&Array.isArray(next[key])?previous[key].length!==next[key].length||previous[key].some((v,i)=>!Object.is(v,next[key][i])):!Object.is(previous[key],next[key]));}
  drawingMarginsChange(panels=this.panels,axes=this.axes){const before=axisStripWidths(this.panels,this.axes,this.axisWidth),after=axisStripWidths(panels,axes,this.axisWidth);return before.some((value,index)=>value!==after[index]);}
  setPanel(id, patch) {optionRecord(patch,PANEL_KEYS.filter(k=>k!=='id'),'Panel patch');const i=this.panels.findIndex(p=>p.id===id);if(i<0)throw new Error('Missing panel');const previous=this.panels[i],next={...previous,...patch};this.validatePanel(next);if(this.drawings?.transaction&&(this.drawingProjectionChange(previous,next,['weight'])||this.drawingMarginsChange(this.panels.map((p,j)=>j===i?next:p))||this.drawingProjectionChange(previous,next,['scale','inverted','padding','range','base','axisVisible','axisSide'])&&[...this.drawings.items,...this.drawings.transaction].some(d=>d.panel===id)))throw new Error('Panel projection change during drawing transaction');this.panels[i]=next;}
  validateAxis(a) {
    optionRecord(a,AXIS_KEYS,'Axis');identifier(a.id,'Axis id');identifier(a.panel,'Axis panel');
    if(!this.panels.some(p=>p.id===a.panel))throw new Error('Missing axis panel');
    this.validatePanel({weight:1,scale:'linear',inverted:false,padding:.08,...Object.fromEntries(['scale','inverted','padding','range','base','precision','formatter','label'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]))});
    if(!['left','right'].includes(a.side)||typeof a.visible!=='boolean'||!['fixed','scientific'].includes(a.tickFormat)||a.width!==undefined&&(!Number.isFinite(a.width)||a.width<20||a.width>256))throw new TypeError('Axis side/visibility/format/width');
    for(const key of ['prefix','suffix'])if(a[key]!==undefined)boundedText(a[key],64,'Axis '+key,true);
    if(a.scale==='percent'&&(!Number.isFinite(a.base)||a.base===0))throw new RangeError('Independent percent axis requires an explicit nonzero base');
    return true;
  }
  addAxis(options) {optionRecord(options,AXIS_KEYS,'Axis');if(this.axes.length>=RESOURCE_LIMITS.maxAxes)throw new RangeError('Axis limit');if(this.axes.some(a=>a.id===options.id))throw new Error('Duplicate axis');const a={side:'right',scale:'linear',inverted:false,padding:.08,visible:true,tickFormat:'fixed',...options};this.validateAxis(a);if(this.drawings?.transaction&&this.drawingMarginsChange(this.panels,[...this.axes,a]))throw new Error('Axis layout change during drawing transaction');this.axes.push(a);return a.id;}
  setAxis(id,patch) {optionRecord(patch,AXIS_KEYS.filter(k=>k!=='id'&&k!=='panel'),'Axis patch');const i=this.axes.findIndex(a=>a.id===id);if(i<0)throw new Error('Missing axis');const previous=this.axes[i],a={...previous,...patch};this.validateAxis(a);if(this.drawings?.transaction&&(this.drawingMarginsChange(this.panels,this.axes.map((axis,j)=>j===i?a:axis))||this.drawingProjectionChange(previous,a,['scale','inverted','padding','range','base','width','side','visible'])&&[...this.drawings.items,...this.drawings.transaction].some(d=>d.axisId===id)))throw new Error('Axis projection change during drawing transaction');this.axes[i]=a;}
  removeAxis(id) {if(this.series.some(s=>s.axisId===id)||[...this.drawings.items,...this.drawings.transaction??[],...this.drawings.undoStack.flat(),...this.drawings.redoStack.flat()].some(d=>d.axisId===id))throw new Error('Axis is referenced by series or drawing history/transaction');const axes=this.axes.filter(a=>a.id!==id);if(this.drawings.transaction&&this.drawingMarginsChange(this.panels,axes))throw new Error('Axis layout change during drawing transaction');this.axes=axes;}
  validateDrawingBinding(d,{allowOrphanSeries=false}={}) {
    if(d.panel!==undefined)identifier(d.panel,'Drawing panel');for(const key of ['axisId','seriesId'])if(d[key]!==undefined&&d[key]!==null)identifier(d[key],'Drawing '+key);
    if(!this.panels.some(p=>p.id===(d.panel??'price')))throw new Error('Missing drawing panel');
    if(d.axisId!==undefined&&d.axisId!==null&&!this.axes.some(a=>a.id===d.axisId&&a.panel===d.panel))throw new Error('Missing drawing axis binding');
    if(!allowOrphanSeries&&d.seriesId!==undefined&&d.seriesId!==null){const s=this.series.find(s=>s.id===d.seriesId);if(!s||s.panel!==d.panel||(s.axisId??null)!==(d.axisId??null))throw new Error('Missing or mismatched drawing series binding');}
    return true;
  }
  normalizedSeries(options) {
    optionRecord(options,SERIES_KEYS,'Series');identifier(options.id,'Series id');identifier(options.panel,'Series panel');
    if(options.axisId!==undefined&&options.axisId!==null){identifier(options.axisId,'Series axis');if(!this.axes.some(a=>a.id===options.axisId&&a.panel===options.panel))throw new Error('Missing series axis in panel');}
    if(options.symbolId!==undefined){identifier(options.symbolId,'Series symbol');if(!options.values)throw new TypeError('symbolId belongs to externally aligned values; store/indicator series use primary symbol');}
    if(options.label!==undefined)boundedText(options.label,256,'Series label');
    for(const key of ['color','fill','upColor','downColor'])if(options[key]!==undefined&&options[key]!==null)boundedText(options[key],128,key);
    if(options.visible!==undefined&&typeof options.visible!=='boolean'||options.width!==undefined&&(!Number.isFinite(options.width)||options.width<=0||options.width>50)||options.baseline!==undefined&&!Number.isFinite(options.baseline))throw new TypeError('Series style/visibility');
    if(!options?.id||!this.panels.some(p=>p.id===options.panel)) throw new Error('Unique series id and existing panel required');
    if(['candles','ohlc'].includes(options.type)&&(options.indicator||options.values||options.source!==undefined||options.symbolId!==undefined))throw new TypeError('Candles/OHLC use primary store OHLCV');
    if (!['candles', 'ohlc', 'line', 'area', 'histogram'].includes(options.type)) throw new Error('Unknown series type');
    if(options.values&&options.indicator)throw new TypeError('Series chooses external values or indicator output');
    if (options.values && (!(options.values instanceof Float64Array) || options.values.length !== this.store.length)) throw new TypeError('Values must be aligned Float64Array');
    const data = options.indicator ? this.indicators.get(options.indicator) : null;if(options.source!==undefined&&!['time','open','high','low','close','volume'].includes(options.source))throw new TypeError('Series source');if(data&&options.output!==undefined&&!Object.hasOwn(data.outputs,options.output))throw new Error('Missing indicator output');const output=options.output??(data?Object.keys(data.outputs)[0]:undefined),offset=options.offset??(data&&Object.hasOwn(data.plotOffsets,output)?data.plotOffsets[output]:0);
    if (!Number.isInteger(offset) || Math.abs(offset) > 10000 || ['candles','ohlc'].includes(options.type) && offset !== 0) throw new RangeError('Series plot offset');
    return {color:'#7898ff',width:['candles','ohlc'].includes(options.type)?1:1.5,...options,offset,dirtyFrom:0};
  }
  addSeries(options){if(this.series.length>=RESOURCE_LIMITS.maxSeries)throw new RangeError('Series limit');if(this.series.some(s=>s.id===options?.id))throw new Error('Duplicate series');const validated=this.normalizedSeries(options);this.series.push(validated);return validated.id;}
  removeSeries(id) {this.series = this.series.filter(s => s.id !== id);}
  setSeriesValues(id, values) {const s = this.series.find(s => s.id === id); if (!s || !(values instanceof Float64Array) || values.length !== this.store.length) throw new TypeError('Aligned values and existing series required'); if(['candles','ohlc'].includes(s.type)||s.indicator)throw new TypeError('External values require a general non-indicator series');s.values = values; s.dirtyFrom = 0;this.seriesValueRevisions.set(s,(this.seriesValueRevisions.get(s)??0)+1);this.seriesValuesRevision=(this.seriesValuesRevision??0)+1;}
  seriesData(s) {
    if(this.disposed)throw new Error('Chart disposed');
    let values, revision, computedFrom = 0,computedUntil=this.store.length;
    if (s.indicator) {const data = this.indicators.get(s.indicator); values = data.outputs[s.output ?? Object.keys(data.outputs)[0]]; if (!values) throw new Error('Missing indicator output'); revision = data.revision; computedFrom = data.computedFrom;computedUntil=data.computedUntil;}
    else {values = s.values ?? this.store.columns[s.source ?? 'close'].subarray(0, this.store.length); revision = this.store.version; computedFrom = s.dirtyFrom ?? 0;}
    // A custom indicator callback may dispose its owner during calculation.
    // Never reattach output vectors through a new index after that teardown.
    if(this.disposed)throw new Error('Chart disposed');
    const blocked=values.length>=SERIES_BLOCK_THRESHOLD,policyMismatch=s.rangeIndex&&(s.rangeIndex instanceof BlockRangeIndex)!==blocked;
    // Rebuild only on data changes; pan/zoom uses O(log N) range queries.
    if (s.dirtyFrom < Infinity || s.revision !== revision || !s.rangeIndex || s.rangeIndex.finiteCounts!==true || policyMismatch) {const start = Math.min(s.dirtyFrom ?? Infinity, computedFrom); if (s.indicator&&s.revision!==undefined&&revision>s.revision+1 || !s.rangeIndex || s.rangeIndex.finiteCounts!==true || policyMismatch || s.rangeIndex.size !== this.store.capacity || computedUntil - start > values.length / 4) s.rangeIndex = blocked?new BlockRangeIndex(values.length,values,this.store.capacity):new RangeIndex(values.length, values, values, null, this.store.capacity, true); else {if(s.rangeIndex instanceof BlockRangeIndex){for(let i=start;i<computedUntil;i+=s.rangeIndex.blockSize)s.rangeIndex.update(i);if(computedUntil>start)s.rangeIndex.update(computedUntil-1);}else for(let i=start;i<computedUntil;i++)s.rangeIndex.update(i,values[i]);}s.revision = revision;s.dirtyFrom = Infinity;}
    return {values, index: s.rangeIndex};
  }
  forwardOffset() {return Math.max(0,...this.series.filter(s=>s.visible!==false).map(s=>s.offset??0));}
  setVisibleRange(from, to) {if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new RangeError('Visible range'); const n = Math.max(10, this.store.length + this.forwardOffset()), span = Math.min(n, Math.max(Math.min(10, n), to - from)); let a = Math.max(-.5, Math.min(n - .5 - span, from)); this.view = {from: a, to: a + span}; this.follow = Math.abs(this.view.to - (this.store.length + this.forwardOffset() - .5)) < 1;}
  fit() {this.setVisibleRange(-.5, Math.max(9.5, this.store.length + this.forwardOffset() - .5));}
  zoom(factor, anchor = .5) {if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('Zoom factor'); anchor = Math.max(0, Math.min(1, anchor)); const span = this.view.to - this.view.from, at = this.view.from + span * anchor, next = span * factor; this.setVisibleRange(at - next * anchor, at + next * (1 - anchor));}
  pan(deltaBars) {this.setVisibleRange(this.view.from + deltaBars, this.view.to + deltaBars);}
  dispose() {if(this.disposed)return;this.disposed=true;try{this.dataIngestion?.dispose();this.dataIngestion=null;this.unsubscribe();this.indicators.dispose();for(const s of this.series)s.rangeIndex=null;}finally{unregisterStoreOwner(this);}}
}

// Independent price domains share only the reference time geometry.
function axisRange(model, config, series, a, b, left, right, top, bottom) {
  let min=Infinity,max=-Infinity;
  for(const s of series){const volume=aggregateVolumeSeries(s)?model.store.aggregate(a,b,Math.max(1,Math.floor((right-left)/3))):null;
    const sa=Math.min(model.store.length,Math.max(0,Math.floor(model.view.from-(s.offset??0)))),sb=Math.max(sa,Math.min(model.store.length,Math.ceil(model.view.to+1-(s.offset??0))));
    const q=volume?{min:0,max:Math.max(0,...volume.map(b=>b.volume))}:['candles','ohlc'].includes(s.type)?model.store.index.query(a,b):model.seriesData(s).index.query(sa,sb);
    min=Math.min(min,q.min);max=Math.max(max,q.max);if(['histogram','area'].includes(s.type)){min=Math.min(min,s.baseline??0);max=Math.max(max,s.baseline??0);}
  }
  const sourceMin=min,sourceMax=max;
  if(!Number.isFinite(min)||!Number.isFinite(max)){min=config.scale==='log'?1:0;max=config.scale==='log'?10:1;}
  if(config.scale==='log'&&Number.isFinite(min)&&min<=0)throw new RangeError('Log scale requires strictly positive visible data');
  if(config.range)[min,max]=config.range;
  else{const baseline=min===0&&series.some(s=>['histogram','area'].includes(s.type)&&(s.baseline??0)===0),padding=max===min?(Math.abs(max)*.01||1)*config.padding:max*config.padding-min*config.padding;min=Math.max(-Number.MAX_VALUE,min-padding);max=Math.min(Number.MAX_VALUE,max+padding);if(baseline)min=0;}
  if(min===max){const delta=Math.abs(min)*1e-12||1;min=Math.max(-Number.MAX_VALUE,min-delta);max=Math.min(Number.MAX_VALUE,max+delta);}if(config.scale==='log'&&min<=0)throw new RangeError('Log scale requires a strictly positive visible range (adjust padding/range)');
  const base=config.base??(model.store.length?model.store.columns.close[0]:1);if(config.scale==='percent'&&base===0)throw new RangeError('Percent base cannot be zero');
  const transform=config.scale==='log'?Math.log:config.scale==='percent'?v=>(v/base-1)*100:v=>v,inverse=config.scale==='log'?Math.exp:config.scale==='percent'?v=>(v/100+1)*base:v=>v;
  const lo=transform(min),hi=transform(max);if(!Number.isFinite(lo)||!Number.isFinite(hi))throw new RangeError('Axis transform overflow');const magnitude=Math.max(Math.abs(lo),Math.abs(hi))||1,span=hi/magnitude-lo/magnitude;
  if(!Number.isFinite(span)||span===0)throw new RangeError('Axis transform has no representable span');
  const y=value=>{const coordinate=top+(config.inverted?(transform(value)/magnitude-lo/magnitude)/span:(hi/magnitude-transform(value)/magnitude)/span)*(bottom-top);return coordinate>=-3.4028234663852886e38&&coordinate<=3.4028234663852886e38?coordinate:NaN;};
  if(Number.isFinite(sourceMin)&&(!Number.isFinite(Math.fround(y(sourceMin)))||!Number.isFinite(Math.fround(y(sourceMax)))))throw new RangeError('Axis projection overflow for visible values');
  const price=sy=>{const fraction=(sy-top)/(bottom-top),f=config.inverted?fraction:1-fraction;return inverse(((1-f)*(lo/magnitude)+f*(hi/magnitude))*magnitude);};
  return {...config,left,right,top,bottom,min,max,base,y,price,transform,inverse,lo,hi};
}
function createLayout(model,width,height) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<100||height<80||width>RESOURCE_LIMITS.maxCanvasDimension||height>RESOURCE_LIMITS.maxCanvasDimension)throw new RangeError('Chart needs at least 100 × 80 CSS pixels');
  const configs=model.panels.map(p=>[{...p,axisId:null,side:p.axisSide??'right',visible:p.axisVisible!==false,width:model.axisWidth},...model.axes.filter(a=>a.panel===p.id).map(a=>({...a,axisId:a.id,width:a.width??model.axisWidth}))]);
  const [leftStrip,rightStrip]=axisStripWidths(model.panels,model.axes,model.axisWidth);
  const factor=Math.min(1,(width-32)/(leftStrip+rightStrip||1)),left=12+leftStrip*factor,right=Math.max(left+20,width-rightStrip*factor),total=model.panels.reduce((n,p)=>n+p.weight,0),a=Math.min(model.store.length,Math.max(0,Math.floor(model.view.from))),b=Math.max(a,Math.min(model.store.length,Math.ceil(model.view.to+1)));
  const footer=Math.min(height-24,Math.max(38,Math.ceil(labelMetrics(model.theme.font).height+20))),panelSpace=height-footer;let top=12;
  const panels=model.panels.map((p,i)=>{const row=panelSpace*p.weight/total,gap=Math.min(8,row/2),bottom=top+row-gap,series=model.series.filter(s=>s.panel===p.id&&s.visible!==false);let lx=left,rx=right;
    const axes=configs[i].map(config=>{const q=axisRange(model,config,series.filter(s=>(s.axisId??null)===config.axisId),a,b,left,right,top,bottom);const w=config.visible?config.width*factor:0;q.axisLeft=config.side==='left'?lx-w:rx;q.axisRight=q.axisLeft+w;q.textX=config.side==='left'?q.axisLeft+4:q.axisLeft+8;if(config.side==='left')lx-=w;else rx+=w;return q;});
    const result={...axes[0],axes};top=bottom+gap;return result;});
  const axis=(panelId,axisId=null)=>panels.find(p=>p.id===panelId)?.axes.find(a=>a.axisId===(axisId??null));
  const drawingAxis=d=>{if(d.seriesId!==undefined&&d.seriesId!==null){const s=model.series.find(s=>s.id===d.seriesId);if(!s||s.visible===false||s.panel!==d.panel||(s.axisId??null)!==(d.axisId??null))return undefined;}return axis(d.panel,d.axisId);};
  const x=index=>left+(index-model.view.from)/(model.view.to-model.view.from)*(right-left),index=sx=>model.view.from+(sx-left)/(right-left)*(model.view.to-model.view.from);
  const geometryKey=JSON.stringify([width,height,model.view.from,model.view.to,model.store.geometryIdentity,model.store.timeVersion,...panels.flatMap(p=>p.axes.map(a=>[p.id,a.axisId,a.left,a.right,a.top,a.bottom,a.min,a.max,a.scale,a.inverted,a.base])),...model.series.map(s=>[s.id,s.panel,s.axisId,s.visible])]);
  return {geometryKey,geometryFont:model.theme.font,width,height,panels,axis,drawingAxis,x,index,from:a,to:b,toScreen:(point,panelId,axisId=null)=>{const p=axis(panelId,axisId);return p?{x:x(model.store.indexAtTime(point.time)),y:p.y(point.price)}:{x:NaN,y:NaN};},fromScreen:(sx,sy,panelId,axisId=null)=>{const p=axis(panelId,axisId);if(!p)throw new Error('Missing axis');return {time:model.store.timeAtIndex(index(sx)),price:p.price(sy)};}};
}


// Renderer-neutral CSS-pixel display list. Raw price/time never become float32.
function buildScene(model, width, height, {crosshair = true, drawings = true} = {}) {
  const layout = createLayout(model, width, height), theme = model.theme, commands = [], {from, to} = layout;
  const line = (coords, color, stroke = 1, clip = null, dash = null) => {if (coords.length) commands.push({op: 'lines', coords, color, width: stroke, clip, dash});};
  const metrics=labelMetrics(theme.font);
  const text=(value,x,y,maxWidth,clip,metadata)=>{const c=labelCommand(value,x,y,maxWidth,theme.font,theme.text,clip,metadata);if(c)commands.push(c);return c;};
  if(!model.store.length){commands.push({op:'text',x:Math.max(12,width/2-60),y:height/2,text:'No data',color:theme.text,font:theme.font});return {width,height,background:theme.background,commands,layout,stats:{storedBars:0,visibleSourceBars:0,renderedCandleBuckets:0,commandCount:1}};}
  const buckets = model.store.aggregate(from, to, Math.max(1, Math.floor((layout.panels[0].right-layout.panels[0].left) / 3)));
  for (const p of layout.panels) {
    const clip = [p.left, p.top, p.right - p.left, p.bottom - p.top], grid = [];
    const priceTicks=Math.max(1,Math.min(4,Math.floor((p.bottom-p.top)/40)));
    for(let j=0;j<=priceTicks;j++){const y=p.top+j*(p.bottom-p.top)/priceTicks;grid.push(p.left,y,p.right,y);}
    for(let j=0;j<=5;j++){const x=p.left+(p.right-p.left)*j/5;grid.push(x,p.top,x,p.bottom);}line(grid,theme.grid);
    for(const axis of p.axes.filter(a=>a.visible)){
      const axisClip=[axis.axisLeft,p.top,axis.axisRight-axis.axisLeft,p.bottom-p.top],x=axis.axisLeft+4,maxWidth=axis.axisRight-x-4,hasTitle=!!axis.label&&p.bottom-p.top>=metrics.height*2+12;
      let labelTop=p.top+4;if(hasTitle){text(axis.label,x,labelTop+metrics.ascent,maxWidth,axisClip,{role:'axis-title',panelId:p.id,axisId:axis.axisId});labelTop+=metrics.height+4;}
      const space=p.bottom-4-labelTop,count=Math.max(0,Math.min(5,Math.floor((space+4)/(metrics.height+4))));
      for(let j=0;j<count;j++){const top=labelTop+(count===1?(space-metrics.height)/2:j*(space-metrics.height)/(count-1)),y=top+metrics.ascent,at=Math.max(p.top,Math.min(p.bottom,top+metrics.height/2));text(formatAxisValue(model,axis,axis.price(at)),x,y,maxWidth,axisClip,{role:'price-tick',panelId:p.id,axisId:axis.axisId});}
    }
    for (const s of model.series.filter(s => s.panel === p.id && s.visible !== false)) {
      const axis=layout.axis(p.id,s.axisId);if(!axis)continue;
      if (s.type === 'candles' || s.type === 'ohlc') {
        const upRects = [], downRects = [], upLines = [], downLines = [];
        for (const b of buckets) {
          const x = layout.x(b.index), w = Math.max(.8, (layout.x(b.end) - layout.x(b.start)) * .72), up = b.close >= b.open, coords = up ? upLines : downLines;
          coords.push(x, axis.y(b.high), x, axis.y(b.low));
          if (s.type === 'ohlc') coords.push(x - w / 2, axis.y(b.open), x, axis.y(b.open), x, axis.y(b.close), x + w / 2, axis.y(b.close));
          else (up ? upRects : downRects).push(x - w / 2, Math.min(axis.y(b.open), axis.y(b.close)), w, Math.max(1, Math.abs(axis.y(b.open) - axis.y(b.close))));
        }
        line(upLines, s.upColor ?? theme.up, s.width ?? 1, clip); line(downLines, s.downColor ?? theme.down, s.width ?? 1, clip);
        if (upRects.length) commands.push({op: 'rects', coords: upRects, color: s.upColor ?? theme.up, clip});
        if (downRects.length) commands.push({op: 'rects', coords: downRects, color: s.downColor ?? theme.down, clip});
      } else if (aggregateVolumeSeries(s)) {
        const coords = [], baseline = axis.y(0);
        for (const b of buckets) {const x = layout.x(b.index), w = Math.max(.8, (layout.x(b.end) - layout.x(b.start)) * .72); coords.push(x - w / 2, Math.min(baseline,axis.y(b.volume)), w, Math.max(1, Math.abs(baseline - axis.y(b.volume))));}
        if (coords.length) commands.push({op: 'rects', coords, color: s.color, clip});
      } else {
        const sf = Math.min(model.store.length,Math.max(0,Math.floor(model.view.from-(s.offset??0)))), st = Math.max(sf,Math.min(model.store.length,Math.ceil(model.view.to+1-(s.offset??0))));
        const {values, index} = model.seriesData(s), count = Math.min(st - sf, Math.max(1, Math.floor(p.right - p.left))), coords = [], rects = [], paths = [], gaps = index.hasGaps(sf,st); let path = [];
        const flush=()=>{if(path.length===2){const x=path[0],y=path[1];coords.push(x-.25,y,x+.25,y);}else if(path.length)paths.push(path);path=[];};
        const histogram=(x,v,width)=>{const baseline=axis.y(s.baseline??0);rects.push(x-width/2,Math.min(baseline,axis.y(v)),width,Math.max(1,Math.abs(baseline-axis.y(v))));};
        for (let k = 0; k < count; k++) {
          const a=sf+Math.floor(k*(st-sf)/count),b=sf+Math.floor((k+1)*(st-sf)/count),end=Math.min(b,values.length),finite=gaps?index.finiteCount(a,end):end-a;
          if(!finite){flush();continue;}
          if(finite!==end-a){
            // A mixed bucket is split into actual finite runs, never discarded
            // or bridged. Isolated finite samples get a small point glyph.
            const width=Math.max(1,Math.abs(layout.x(a+1)-layout.x(a))*.8);
            for(let i=a;i<end;i++){const v=values[i];if(!Number.isFinite(v)){flush();continue;}const x=layout.x(i+(s.offset??0));if(s.type==='histogram')histogram(x,v,width);else path.push(x,axis.y(v));}
            continue;
          }
          const x=layout.x((a+b-1)/2+(s.offset??0)),v=values[end-1];
          if(s.type==='histogram')histogram(x,v,Math.max(1,(p.right-p.left)/count*.8));
          else{const q=index.query(a,end);path.push(x,axis.y(v));if(b-a>1&&q.max!==q.min)coords.push(x,axis.y(q.min),x,axis.y(q.max));}
        }
        flush();
        if (rects.length) commands.push({op: 'rects', coords: rects, color: s.color, clip});
        for (const points of paths) commands.push({op: 'path', points, color: s.color, width: s.width, fill: s.type === 'area' ? s.fill ?? '#7898ff22' : null, baseline:s.type==='area'?axis.y(s.baseline??0):undefined, clip});
        line(coords, s.color, s.width, clip);
      }
    }
    if(p.bottom-p.top>=metrics.height+8){const title=labelCommand(panelTitle(model,p),p.left+4,p.top+4+metrics.ascent,p.right-p.left-8,theme.font,theme.text,clip,{role:'panel-title',panelId:p.id});if(title){commands.push({op:'box',x:p.left,y:p.top,w:title.labelBounds[2]+8,h:metrics.height+8,fill:theme.background,color:theme.background,width:0,clip});commands.push(title);}}
  }
  const firstPanel=layout.panels[0],timeWidth=firstPanel.right-firstPanel.left,timeClip=[firstPanel.left,Math.max(firstPanel.bottom+4,height-metrics.height-8),timeWidth,Math.min(metrics.height+8,height-firstPanel.bottom-4)],baseline=height-4-metrics.descent;
  if(timeClip[3]>=metrics.height){
    const valueAt=fraction=>{const i=model.view.from+(model.view.to-model.view.from)*fraction,t=model.store.timeAtIndex(i);return model.timeFormatter?model.timeFormatter(t):new Date(t).toISOString().slice(5,16).replace('T',' ');};
    const maxLabelWidth=Math.max(labelWidth(String(valueAt(0)),metrics),labelWidth(String(valueAt(1)),metrics)),count=Math.max(1,Math.min(5,Math.floor((timeWidth+4)/(maxLabelWidth+4))));let lastRight=-Infinity;
    for(let j=0;j<count;j++){const fraction=count===1?.5:j/(count-1),value=valueAt(fraction),candidate=labelCommand(value,0,baseline,timeWidth,theme.font,theme.text,timeClip,{role:'time-tick'});if(!candidate)continue;const x=Math.max(firstPanel.left,Math.min(firstPanel.right-candidate.labelBounds[2],firstPanel.left+timeWidth*fraction-candidate.labelBounds[2]/2));if(x<lastRight+4)continue;candidate.x=x;candidate.labelBounds[0]=x;commands.push(candidate);lastRight=x+candidate.labelBounds[2];}
  }
  if (drawings) for(const command of createDrawingCommands(model,layout))commands.push(command);
  if (crosshair) for(const command of createCrosshairCommands(model,layout))commands.push(command);
  return {width, height, background: theme.background, commands, layout, stats: {storedBars: model.store.length, visibleSourceBars: to - from, renderedCandleBuckets: buckets.length, commandCount: commands.length}};
}


function staticState(model, width, height) {
  const state = [width, height, model.store, model.store.version, model.store.length, model.store.timeVersion, model.view.from, model.view.to, model.axisWidth, model.precision, model.priceFormatter, model.timeFormatter];
  for (const key of ['background', 'grid', 'text', 'up', 'down', 'font']) state.push(model.theme[key]);
  state.push(model.panels.length);
  for (const p of model.panels) state.push(p.id, p.weight, p.scale, p.inverted, p.padding, p.range?.[0], p.range?.[1], p.base, p.precision, p.label,p.formatter,p.axisVisible,p.axisSide);
  state.push(model.axes.length);for(const a of model.axes)state.push(a.id,a.panel,a.side,a.scale,a.inverted,a.padding,a.range?.[0],a.range?.[1],a.base,a.precision,a.tickFormat,a.prefix,a.suffix,a.label,a.visible,a.width,a.formatter);
  state.push(model.series.length);
  for (const s of model.series) {
    state.push(s.id, s.type, s.panel, s.visible, s.offset, s.values, s.source, s.indicator, s.output, s.color, s.upColor, s.downColor, s.fill, s.width, s.baseline,s.dirtyFrom,s.axisId,s.symbolId,s.label);
    const entry = s.indicator ? model.indicators.entries.get(s.indicator) : null;
    state.push(entry, entry?.def, entry?.revision, entry?.dirty, entry?.length);
  }
  return state;
}
function same(a, b) {return !!a && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));}

// One latest scene only. No growing map or full data/output copies on hover.
class SceneCache {
  constructor() {this.clear();}
  clear() {this.base = null; this.state = null; this.items = null; this.selected = undefined; this.drawingCommands = null;}
  frame(model, width, height, {forceBase = false} = {}) {
    const next = staticState(model, width, height), baseChanged = forceBase || !same(this.state, next);
    let base = this.base;
    if (baseChanged) base = buildScene(model, width, height, {crosshair: false, drawings: false});
    const items = model.drawings.items, drawingsChanged = baseChanged || this.selected !== model.drawings.selected || !same(this.items, items);
    const drawings = drawingsChanged ? model.store.length ? createDrawingCommands(model, base.layout) : [] : this.drawingCommands;
    const hover = createCrosshairCommands(model, base.layout), commands = base.commands.concat(drawings, hover);
    const scene = {...base, commands, stats: {...base.stats, commandCount: commands.length}};
    this.base = base; this.state = staticState(model, width, height); this.items = items.slice(); this.selected = model.drawings.selected; this.drawingCommands = drawings;
    return {scene, base, drawings: {...base, commands: drawings}, hover: {...base, commands: hover}, baseChanged, drawingsChanged};
  }
}


// DOM-free pointer state machine shared by browser, native host, and tests.
class InteractionController {
  constructor(model, size, invalidate = () => {}) {this.model = model; this.size = size; this.invalidate = invalidate; this.pointers = new Map(); this.tool = 'select'; this.gesture = null; this.text = 'Note';this.drawingTarget=null;}
  layout() {const {width, height} = this.size(); return createLayout(this.model, width, height);}
  drawingProjection(layout,panel,axisId){const axis=layout.axis(panel,axisId);return axis?[axis.left,axis.right,axis.top,axis.bottom,axis.min,axis.max,axis.scale,axis.inverted,axis.base,this.model.view.from,this.model.view.to,this.model.store.geometryIdentity,this.model.store.timeVersion]:null;}
  setTool(tool,{notify=true}={}) {if (tool !== 'select' && !DRAWING_TYPES.includes(tool)) throw new Error('Unknown drawing tool'); this.cancel({notify:false}); this.tool = tool; if(notify)this.invalidate();}
  setDrawingTarget(target,{notify=true}={}){if(target!==null){optionRecord(target,['panel','axisId','seriesId'],'Drawing target');const next={panel:'price',...target};identifier(next.panel,'Drawing target panel');if(next.seriesId!=null&&next.axisId===undefined){const s=this.model.series.find(s=>s.id===next.seriesId);if(s)next.axisId=s.axisId??null;}this.model.validateDrawingBinding(next);this.cancel({notify:false});this.drawingTarget=next;}else{this.cancel({notify:false});this.drawingTarget=null;}if(notify)this.invalidate();}
  down(id, x, y, hitTolerance = 8) {
    if(!Number.isFinite(hitTolerance)||hitTolerance<1||hitTolerance>32)throw new RangeError('Pointer hit tolerance must be 1..32 logical pixels');
    if (![x, y].every(Number.isFinite)) return;
    if (this.pointers.size >= 2 && !this.pointers.has(id)) return;
    this.pointers.set(id, {x, y});
    if (this.pointers.size === 2) {
      // Pinch takes ownership; any in-progress drawing/edit is restored.
      this.model.drawings.cancel(); const [a, b] = [...this.pointers.values()];
      this.gesture = {kind: 'pinch', distance: Math.hypot(b.x - a.x, b.y - a.y) || 1, view: {...this.model.view}, follow: this.model.follow, midpoint: (a.x + b.x) / 2}; this.invalidate(); return;
    }
    if (this.pointers.size > 2) return;
    const layout = this.layout(), p = layout.panels.find(p => y >= p.top && y <= p.bottom && x >= p.left && x <= p.right); if (!p) {this.gesture = null; return;}
    if (this.tool !== 'select') {
      const target=this.drawingTarget??{panel:p.id};if(target.panel!==p.id)return;this.model.validateDrawingBinding(target);const point=layout.fromScreen(x,y,p.id,target.axisId);this.model.drawings.begin();
      const points=Array.from({length:drawingPointCount(this.tool)},()=>({...point}));
      const drawingId = this.model.drawings.add({type: this.tool, ...target,panel: p.id, points, ...(this.tool === 'text' ? {text: this.text} : {})});
      this.gesture = {kind: 'create', id: drawingId,panel:p.id,axisId:target.axisId,seriesId:target.seriesId,type:this.tool,projection:this.drawingProjection(layout,p.id,target.axisId),lastX:x,lastY:y, moved:false};
    } else {
      const hit = drawingHitTest(this.model.drawings, layout, x, y, hitTolerance); this.model.drawings.selected = hit?.id ?? null;
      if (hit && !hit.locked) {const d = this.model.drawings.items.find(d => d.id === hit.id); this.model.drawings.begin(); this.gesture = {kind: 'edit', id: hit.id, handle: hit.handle, startX: x, startY: y, screenPoints: d.points.map(q => layout.toScreen(q,p.id,d.axisId)), points:d.points.map(p=>({...p})),panel:p.id,axisId:d.axisId,seriesId:d.seriesId,type:d.type,projection:this.drawingProjection(layout,p.id,d.axisId)};}
      else this.gesture = {kind: 'pan', startX: x, view: {...this.model.view}, follow: this.model.follow, pixelWidth: p.right - p.left};
    }
    this.invalidate('drawings');
  }
  move(id, x, y) {
    if(![x,y].every(Number.isFinite))return;
    this.model.crosshair = {x, y}; const g = this.gesture;
    if (!this.pointers.has(id)) {this.invalidate('hover'); return;}
    this.pointers.set(id, {x, y});
    if (!g) return;
    if (g.kind === 'pinch') {
      if (this.pointers.size !== 2) return; const [a, b] = [...this.pointers.values()], layout = this.layout(), p = layout.panels[0], span = g.view.to - g.view.from, factor = g.distance / (Math.hypot(b.x - a.x, b.y - a.y) || 1), anchor = Math.max(0, Math.min(1, (g.midpoint - p.left) / (p.right - p.left))), at = g.view.from + span * anchor, delta = ((a.x + b.x) / 2 - g.midpoint) / (p.right - p.left) * span * factor;
      this.model.setVisibleRange(at - span * factor * anchor - delta, at + span * factor * (1 - anchor) - delta);
    } else if (g.kind === 'pan') {const delta = (g.startX - x) / g.pixelWidth * (g.view.to - g.view.from); this.model.setVisibleRange(g.view.from + delta, g.view.to + delta);}
    else if (g.kind !== 'wait') {
      const layout = this.layout(), d = this.model.drawings.items.find(d => d.id === g.id);
      if (!d || d.locked || !this.model.drawings.transaction || d.panel!==g.panel || (d.axisId??null)!==(g.axisId??null) || (d.seriesId??null)!==(g.seriesId??null) || d.type!==g.type || !layout.drawingAxis(d)) {this.cancel(); return;}
      const projection=this.drawingProjection(layout,g.panel,g.axisId);
      if(!projection||!g.projection||g.projection.some((value,index)=>!Object.is(value,projection[index]))){this.cancel();return;}
      const point = layout.fromScreen(x,y,g.panel,g.axisId);
      if (g.kind === 'create') {
        let points=d.points.length===1?[point]:[d.points[0],point];
        if(d.type==='freehand'){if(Math.hypot(x-g.lastX,y-g.lastY)<1||d.points.length>=2048)return;points=g.moved?[...d.points,point]:points;g.moved=true;g.lastX=x;g.lastY=y;}
        else if(drawingPointCount(d.type)===3)points.push(layout.fromScreen(x,y+40,g.panel,g.axisId));
        this.model.drawings.edit(g.id,{points});
      }
      else {const points = g.points.map((p, i) => g.handle < 0 ? layout.fromScreen(g.screenPoints[i].x + x - g.startX, g.screenPoints[i].y + y - g.startY,g.panel,g.axisId) : i === g.handle ? point : {...p}); this.model.drawings.edit(g.id, {points});}
    }
    this.invalidate(g.kind==='pan'||g.kind==='pinch'?'all':'drawings');
  }
  up(id) {
    if (!this.pointers.has(id)) return; this.pointers.delete(id);
    if (this.gesture?.kind === 'pinch') {this.gesture = this.pointers.size ? {kind: 'wait'} : null;}
    else {if (['create', 'edit'].includes(this.gesture?.kind)) this.model.drawings.commit(); this.gesture = null;}
    this.invalidate();
  }
  cancel({notify=true}={}) {this.model.drawings.cancel(); if (this.gesture?.view) {this.model.view = {...this.gesture.view}; this.model.follow = this.gesture.follow;} this.gesture = null; this.pointers.clear(); if(notify)this.invalidate();}
  wheel(delta, x) {if (this.gesture) return; const p = this.layout().panels[0]; this.model.zoom(Math.exp(Math.max(-1, Math.min(1, delta * .001))), (x - p.left) / (p.right - p.left)); this.invalidate();}
  key(key, {ctrl = false, shift = false} = {}) {
    const undo = ctrl && key.toLowerCase() === 'z' && !shift, redo = ctrl && (key.toLowerCase() === 'y' || key.toLowerCase() === 'z' && shift), deleting = ['Delete', 'Backspace'].includes(key);
    if(key==='Escape'){this.cancel();this.model.drawings.selected=null;this.model.crosshair=null;}
    else if(['PageUp','PageDown'].includes(key)){this.cancel();const items=this.model.drawings.items;if(items.length){const at=items.findIndex(d=>d.id===this.model.drawings.selected),next=(at+(key==='PageUp'?-1:1)+items.length)%items.length;this.model.drawings.selected=items[next].id;}}
    else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key)){if(this.gesture)this.cancel();const d=this.model.drawings.items.find(d=>d.id===this.model.drawings.selected);
      if(d&&!ctrl&&!d.locked&&this.layout().drawingAxis(d)){const layout=this.layout(),step=shift?10:1,dx=key==='ArrowLeft'?-step:key==='ArrowRight'?step:0,dy=key==='ArrowUp'?-step:key==='ArrowDown'?step:0;this.model.drawings.edit(d.id,{points:d.points.map(p=>{const q=layout.toScreen(p,d.panel,d.axisId);return layout.fromScreen(q.x+dx,q.y+dy,d.panel,d.axisId);})});}
      else if(!d||ctrl){if(key==='ArrowLeft'||key==='ArrowRight')this.model.pan((key==='ArrowLeft'?-1:1)*(this.model.view.to-this.model.view.from)*.1);else this.model.zoom(key==='ArrowUp'?.9:1.1);}
    }
    else if(['+','=','-','_'].includes(key))this.model.zoom(key==='+'||key==='='?.8:1.25);
    else if(key==='Home')this.model.fit();else if(key==='End')this.model.setVisibleRange(this.model.store.length-200.5,this.model.store.length-.5);
    else if (undo || redo || deleting) {
      const active = !!this.gesture, selected = this.model.drawings.selected; if (active) this.cancel();
      if (undo && !active) this.model.drawings.undo(); else if (redo) this.model.drawings.redo(); else if (deleting && selected) this.model.drawings.remove(selected);
    }
    this.invalidate();
  }
}

// Internal checkpoint integrity, shared by browser workers and native QuickJS.
// This module deliberately has no TextEncoder/TextDecoder or host scheduling API.
const CHECKPOINT_MAX_TEXT = 8388608, CHECKPOINT_MAX_DEPTH = 32, CHECKPOINT_MAX_NODES = 250000, CHECKPOINT_MAX_HISTORY = 4194304;
const checkpointMarkerValues = Object.freeze({NaN, Infinity, '-Infinity': -Infinity, '-0': -0});
function checkpointFail(message) { throw new TypeError('Checkpoint ' + message); }
function checkpointUnicode(text) {
  for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) checkpointFail('Unicode scalar'); } else if (code >= 0xdc00 && code <= 0xdfff) checkpointFail('Unicode scalar'); }
}

function checkpointWalk(value, decode, depth, budget, ancestors) {
  if (depth > CHECKPOINT_MAX_DEPTH || ++budget.nodes > CHECKPOINT_MAX_NODES) throw new RangeError('Checkpoint state limit');
  if (typeof value === 'string') { checkpointUnicode(value); return value; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (decode && !Number.isFinite(value)) checkpointFail('untagged nonfinite number'); return value; }
  if (!value || typeof value !== 'object') checkpointFail('unsupported value');
  if (ancestors.has(value)) checkpointFail('cyclic state');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) checkpointFail('object type');
  const keys = Object.keys(value);
  if (decode && Object.hasOwn(value, '$asterNumber')) {
    if (keys.length !== 1 || typeof value.$asterNumber !== 'string' || !Object.hasOwn(checkpointMarkerValues, value.$asterNumber)) checkpointFail('number marker');
    return checkpointMarkerValues[value.$asterNumber];
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (keys.length !== value.length || keys.some((key, i) => key !== String(i))) checkpointFail('array shape');
    for (let i = 0; i < value.length; i++) { const descriptor = decode ? null : Object.getOwnPropertyDescriptor(value, i); if (!decode && (!descriptor || !Object.hasOwn(descriptor, 'value'))) checkpointFail('accessor state'); const item = checkpointWalk(decode ? value[i] : descriptor.value, decode, depth + 1, budget, ancestors); if (decode) value[i] = item; }
  } else for (const key of keys) {
    checkpointUnicode(key); const descriptor = decode ? null : Object.getOwnPropertyDescriptor(value, key);
    if (!decode && (!descriptor || !Object.hasOwn(descriptor, 'value'))) checkpointFail('accessor state');
    const item = checkpointWalk(decode ? value[key] : descriptor.value, decode, depth + 1, budget, ancestors); if (decode) value[key] = item;
  }
  ancestors.delete(value); return value;
}
function safeCheckpointStringify(state) {
  checkpointWalk(state, false, 0, {nodes: 0}, new Set());
  const text = JSON.stringify(state, (_key, value) => typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)) ? {$asterNumber: Object.is(value, -0) ? '-0' : String(value)} : value);
  if (typeof text !== 'string' || text.length > CHECKPOINT_MAX_TEXT) throw new RangeError('Checkpoint text limit');
  return text;
}
function safeCheckpointParse(text) {
  if (typeof text !== 'string' || text.length > CHECKPOINT_MAX_TEXT) throw new RangeError('Checkpoint text limit');
  // Bound nesting before JSON.parse, and reject every raw overflowing token,
  // including one hidden by a duplicate object key in ordinary JSON.parse.
  let depth = 0; const frames = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i; for (i++; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') break; }
      let next = i + 1; while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === ':' && frames.at(-1)) { const key = JSON.parse(text.slice(start, i + 1)), keys = frames.at(-1); if (keys.has(key)) checkpointFail('duplicate state key'); keys.add(key); }
    }
    else if (ch === '{' || ch === '[') { if (++depth > CHECKPOINT_MAX_DEPTH) throw new RangeError('Checkpoint depth limit'); frames.push(ch === '{' ? new Set() : null); }
    else if (ch === '}' || ch === ']') { depth--; frames.pop(); }
    else if (ch === '-' || ch >= '0' && ch <= '9') { let end = i + 1; while (end < text.length && /[0-9eE+.-]/.test(text[end])) end++; if (!Number.isFinite(Number(text.slice(i, end)))) checkpointFail('untagged nonfinite number'); i = end - 1; }
  }
  return checkpointWalk(JSON.parse(text), true, 0, {nodes: 0}, new Set());
}

function checkpointRecord(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) checkpointFail('state record');
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) checkpointFail('state keys');
}
function checkpointNumeric(value, finite = false) { if (typeof value !== 'number' || finite && !Number.isFinite(value)) checkpointFail('state number'); }
function checkpointOutputNumber(value) { checkpointNumeric(value); if (value === Infinity || value === -Infinity) checkpointFail('output number'); }
function checkpointSession(value) { checkpointNumeric(value); if (Number.isNaN(value) || Number.isFinite(value) && !Number.isInteger(value)) checkpointFail('session'); }
function checkpointInteger(value, from, to) { if (!Number.isSafeInteger(value) || value < from || value > to) checkpointFail('state integer'); }
function checkpointPeriod(params, key, fallback) { const n = params[key] ?? fallback; checkpointInteger(n, 1, 10000); return n; }
function checkpointNumbers(value, limit, finite = false) { if (!Array.isArray(value) || value.length > limit) checkpointFail('state array'); for (const v of value) checkpointNumeric(v, finite); }
function checkpointBar(value) { checkpointRecord(value, ['high', 'low', 'close']); for (const key of ['high', 'low', 'close']) checkpointNumeric(value[key], true); if (value.low > value.high || value.close < value.low || value.close > value.high) checkpointFail('previous OHLC'); }
function checkpointNullableBar(value) { if (value !== null) checkpointBar(value); }
function checkpointRing(value, n, index, sum = true) {
  checkpointRecord(value, sum ? ['a', 'head', 'sum'] : ['a', 'head']); checkpointNumbers(value.a, Math.min(n, index), true);
  checkpointInteger(value.head, 0, value.a.length < n ? 0 : n - 1); if (sum) checkpointNumeric(value.sum);
}
function checkpointSmoothing(value, n, index) {
  checkpointRecord(value, ['count', 'sum', 'value']); checkpointInteger(value.count, 0, Math.min(n, index)); checkpointNumeric(value.sum); checkpointNumeric(value.value);
  if (value.value === Infinity || value.value === -Infinity || value.count < n && !Number.isNaN(value.value)) checkpointFail('smoothing state');
}
function checkpointExtreme(value, n, index, maximum) {
  checkpointRecord(value, ['a', 'head']); if (!Array.isArray(value.a) || value.a.length > Math.min(n, index)) checkpointFail('extreme queue');
  // Snapshot state is canonical: expired queue entries have been removed.
  if (value.head !== 0) checkpointFail('extreme queue head');
  let previousIndex = -1, previousValue;
  for (const pair of value.a) {
    if (!Array.isArray(pair) || pair.length !== 2) checkpointFail('extreme pair'); checkpointInteger(pair[0], Math.max(0, index - n), index - 1); checkpointNumeric(pair[1], true);
    if (pair[0] <= previousIndex || previousValue !== undefined && (maximum ? pair[1] >= previousValue : pair[1] <= previousValue)) checkpointFail('extreme ordering'); previousIndex = pair[0]; previousValue = pair[1];
  }
  if (index > 0 && !value.a.length) checkpointFail('empty extreme queue');
}
function checkpointVwma(state,params,index){
 const n=params.period===undefined?20:params.period;checkpointInteger(n,1,10000);
 checkpointRecord(state,['a','head','sums','invalid','positive']);
 if(!Array.isArray(state.a)||state.a.length!==Math.min(n,index))checkpointFail('VWMA window');
 checkpointInteger(state.head,0,n-1);if(state.head!==(index<n?0:index%n))checkpointFail('VWMA head');
 let invalid=0,positive=0;const expected=[[0,0],[0,0],[0,0]];
 const add=(q,v)=>{if(!Number.isFinite(q[0]))return;const a=q[0],t=a+v,c=q[1]+(Math.abs(a)>=Math.abs(v)?(a-t)+v:(v-t)+a);q[0]=Number.isFinite(t)&&Number.isFinite(c)&&Number.isFinite(t+c)?t:NaN;q[1]=Number.isFinite(q[0])?c:0;};
 for(let j=0;j<state.a.length;j++){const row=state.a[(state.head+j)%state.a.length];if(!Array.isArray(row)||row.length!==2)checkpointFail('VWMA pair');checkpointNumeric(row[0]);if(Number.isNaN(row[0]))checkpointFail('VWMA product');checkpointNumeric(row[1],true);if(row[1]<0||row[1]===0&&row[0]!==0)checkpointFail('VWMA volume');invalid+=Number(!Number.isFinite(row[0]));positive+=Number(row[1]>0);add(expected[1],row[1]);if(Number.isFinite(row[0])){add(expected[0],row[0]);add(expected[2],Math.abs(row[0]));}}
 if(state.invalid!==invalid||state.positive!==positive)checkpointFail('VWMA counters');
 if(!Array.isArray(state.sums)||state.sums.length!==3)checkpointFail('VWMA sums');
 const strict=index%n===0||!positive||[1,2].some(k=>!Number.isFinite(expected[k][0]+expected[k][1])||expected[k][0]+expected[k][1]>=Number.MAX_VALUE/4);
 for(let k=0;k<3;k++){const q=state.sums[k],e=expected[k];if(!Array.isArray(q)||q.length!==2)checkpointFail('VWMA compensation');checkpointOutputNumber(q[0]);checkpointNumeric(q[1],true);if(Number.isNaN(q[0])&&q[1]!==0)checkpointFail('VWMA invalid sum');
  const actual=q[0]+q[1],wanted=e[0]+e[1];if(Number.isNaN(actual)!==Number.isNaN(wanted)||actual===Infinity||actual===-Infinity)checkpointFail('VWMA sum status');
  if(strict){if(!q.every((v,i)=>Object.is(v,e[i])))checkpointFail('VWMA canonical sums');}
  else if(Number.isFinite(wanted)){const scale=k===1?Math.abs(wanted):expected[2][0]+expected[2][1],tolerance=Math.max(Number.MIN_VALUE*32*n,Math.abs(scale)*Number.EPSILON*32*n);if(Math.abs(actual-wanted)>tolerance||Math.abs(q[1])>tolerance)checkpointFail('VWMA sum consistency');}
 }
 return state;
}
function checkpointInitialEquals(value, expected) {
  if (Object.is(value, expected)) return true;
  if (!value || !expected || typeof value !== 'object' || typeof expected !== 'object' || Array.isArray(value) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected); return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && checkpointInitialEquals(value[key], expected[key]));
}
const checkpointInitialStates = {
  sma:{},ema:{},wma:{},rsi:{previous:NaN},atr:{previous:NaN},macd:{},bollinger:{mean:0,m2:0,a:[],head:0},donchian:{},aroon:{},stochastic:{},roc:{a:[],head:0},williamsR:{},cci:{},
  obv:{previous:NaN,value:0},vwap:{session:NaN,pv:0,v:0},mfi:{previous:NaN},cmf:{},adx:{previous:null},dema:{},tema:{},hma:{},keltner:{previous:NaN},
  supertrend:{previous:NaN,upper:NaN,lower:NaN,direction:1},ichimoku:{},trix:{previous:NaN},ppo:{},stochRSI:{previous:NaN,valid:0},adl:{value:0},chaikin:{value:0},forceIndex:{previous:NaN},volumeOscillator:{},vortex:{previous:null},
  pivots:{session:NaN,high:NaN,low:NaN,close:NaN,levels:[NaN,NaN,NaN,NaN,NaN]},parabolicSAR:{previous:null,older:null,sar:NaN,ep:NaN,af:.02,direction:1}
};
function validateCheckpointState(name, params, state, index) {
  checkpointInteger(index, 0, CHECKPOINT_MAX_HISTORY);validateIndicatorParams(params);
  if(indicatorModule(name))return validateModuleCheckpoint(name,params,state,index);
  if(name==='vwma')return checkpointVwma(state,params,index);
  if(name==='vwap'||name==='pivots'){const validated=validateSessionCheckpoint(name,params,state,index);if(validated!==null)return validated;}
  if (!Object.hasOwn(checkpointInitialStates, name)) checkpointFail('builtin name');
  if(name==='aroon')checkpointInteger(params.period===undefined?25:params.period,1,10000);
  if (index === 0) { const initial = name === 'parabolicSAR' ? {...checkpointInitialStates[name], af: params.step ?? .02} : checkpointInitialStates[name]; checkpointRecord(state,Object.keys(initial)); if (!checkpointInitialEquals(state, initial)) checkpointFail('initial state'); return state; }
  const p = (fallback = 20) => checkpointPeriod(params, 'period', fallback);
  const check = (allowed, required = allowed) => checkpointRecord(state, allowed, required);
  const number = (key, finite = false) => checkpointNumeric(state[key], finite);
  const smooth = (key, n, optional = false) => { if (Object.hasOwn(state, key)) checkpointSmoothing(state[key], n, index); else if (!optional) checkpointFail('missing smoothing state'); };
  const roll = (key, n, optional = false) => { if (Object.hasOwn(state, key)) checkpointRing(state[key], n, index); else if (!optional) checkpointFail('missing rolling state'); };
  const queue = (key, n, maximum, count = index, optional = false) => { if (Object.hasOwn(state, key)) checkpointExtreme(state[key], n, count, maximum); else if (!optional) checkpointFail('missing extreme state'); };
  const paired = (a, b) => { if (Object.hasOwn(state, a) !== Object.hasOwn(state, b)) checkpointFail('paired state'); };
  switch (name) {
    case 'sma': case 'wma': check(['r']); roll('r', p()); break;
    case 'ema': check(['e']); smooth('e', p()); break;
    case 'rsi': check(['previous','g','l'],['previous']); number('previous',true); paired('g','l'); smooth('g',p(14),true); smooth('l',p(14),true); break;
    case 'atr': check(['previous','tr']); number('previous',true); smooth('tr',p(14)); break;
    case 'macd': case 'ppo': check(['f','l','s']); smooth('f',checkpointPeriod(params,'fast',12)); smooth('l',checkpointPeriod(params,'slow',26)); smooth('s',checkpointPeriod(params,'signal',9)); break;
    case 'bollinger': check(['mean','m2','a','head']); number('mean'); number('m2'); checkpointRing({a:state.a,head:state.head},p(),index,false); break;
    case 'donchian': case 'williamsR': check(['h','l']); queue('h',p(name==='williamsR'?14:20),true); queue('l',p(name==='williamsR'?14:20),false); break;
    case 'aroon': check(['h','l']); queue('h',p(25)+1,true); queue('l',p(25)+1,false); if(state.h.a.at(-1)[0]!==index-1||state.l.a.at(-1)[0]!==index-1||state.h.a.at(-1)[1]<state.l.a.at(-1)[1])checkpointFail('Aroon latest bar'); break;
    case 'stochastic': check(['h','l','k','d']); queue('h',p(14),true); queue('l',p(14),false); roll('k',checkpointPeriod(params,'smoothK',3)); roll('d',checkpointPeriod(params,'smoothD',3)); break;
    case 'roc': check(['a','head']); checkpointRing(state,p(12),index,false); break;
    case 'cci': check(['tp']); roll('tp',p()); break;
    case 'obv': check(['previous','value']); number('previous',true); number('value',true); break;
    case 'vwap': check(['session','pv','v']); checkpointSession(state.session); number('pv'); number('v'); if (state.v < 0) checkpointFail('negative volume'); break;
    case 'mfi': check(['previous','p','n'],['previous']); number('previous'); paired('p','n'); roll('p',p(14),true); roll('n',p(14),true); break;
    case 'cmf': check(['f','v']); roll('f',p()); roll('v',p()); break;
    case 'adx': check(['previous','tr','p','m','dx'],['previous']); checkpointBar(state.previous); paired('tr','p'); paired('p','m'); paired('m','dx'); for (const key of ['tr','p','m','dx']) smooth(key,p(14),true); break;
    case 'dema': case 'tema': check(name==='dema'?['a','b']:['a','b','c']); for (const key of name==='dema'?['a','b']:['a','b','c']) smooth(key,p()); break;
    case 'hma': check(['r','h','f']); roll('r',Math.max(1,Math.floor(Math.sqrt(p())))); roll('h',Math.max(1,Math.floor(p()/2))); roll('f',p()); break;
    case 'keltner': check(['previous','e','a']); number('previous',true); smooth('e',p()); smooth('a',checkpointPeriod(params,'atrPeriod',10)); break;
    case 'supertrend': check(['previous','upper','lower','direction','a']); number('previous',true); number('upper'); number('lower'); if (![1,-1].includes(state.direction)) checkpointFail('direction'); smooth('a',p(10)); break;
    case 'ichimoku': check(['th','tl','kh','kl','bh','bl']); for (const [key,param,n] of [['t','conversion',9],['k','base',26],['b','span',52]]) { queue(key+'h',checkpointPeriod(params,param,n),true); queue(key+'l',checkpointPeriod(params,param,n),false); } break;
    case 'trix': check(['previous','a','b','c']); number('previous'); for(const key of ['a','b','c'])smooth(key,p(15)); break;
    case 'stochRSI': check(['previous','valid','g','l','h','z','k','d'],['previous','valid','k','d']); number('previous',true); checkpointInteger(state.valid,0,index); paired('g','l'); paired('h','z'); smooth('g',p(14),true); smooth('l',p(14),true); queue('h',checkpointPeriod(params,'stochPeriod',14),true,state.valid,state.valid===0); queue('z',checkpointPeriod(params,'stochPeriod',14),false,state.valid,state.valid===0); roll('k',checkpointPeriod(params,'smoothK',3)); roll('d',checkpointPeriod(params,'smoothD',3)); break;
    case 'adl': check(['value']); checkpointOutputNumber(state.value); break;
    case 'chaikin': check(['value','f','l']); number('value'); smooth('f',checkpointPeriod(params,'fast',3)); smooth('l',checkpointPeriod(params,'slow',10)); break;
    case 'forceIndex': check(['previous','e']); number('previous',true); smooth('e',p(13)); break;
    case 'volumeOscillator': check(['f','l']); roll('f',checkpointPeriod(params,'fast',14)); roll('l',checkpointPeriod(params,'slow',28)); break;
    case 'vortex': check(['previous','tr','p','m'],['previous']); checkpointBar(state.previous); paired('tr','p'); paired('p','m'); for(const key of ['tr','p','m'])roll(key,p(14),true); break;
    case 'pivots': check(['session','high','low','close','levels']); checkpointSession(state.session); checkpointBar({high:state.high,low:state.low,close:state.close}); checkpointNumbers(state.levels,5); if(state.levels.length!==5)checkpointFail('pivot levels'); break;
    case 'parabolicSAR': check(['previous','older','sar','ep','af','direction']); checkpointBar(state.previous); checkpointNullableBar(state.older); number('sar'); number('ep'); number('af',true); if(state.af<(params.step??.02)||state.af>(params.max??.2)||![1,-1].includes(state.direction))checkpointFail('SAR state'); if(index===1&&state.older!==null||index>=2&&state.older===null)checkpointFail('SAR history'); break;
  }
  return state;
}

// Native-only bounded checkpoint records. No TextEncoder, timers or DOM APIs.
const NATIVE_CHECKPOINT_RECORD_BYTES=262144,NATIVE_CHECKPOINT_TOTAL_BYTES=33554432;
const nativeCheckpointMaxIndex=4194304;
// Count the exact UTF-16 JSON storage charge before building a record string.
// Snapshot callbacks themselves are trusted and cannot be made allocation-free.
function nativeCheckpointFootprint(state){let chars=0,nodes=0;const ancestors=new Set(),add=n=>{chars+=n;if(chars*2>NATIVE_CHECKPOINT_RECORD_BYTES)throw new RangeError('Native checkpoint record byte limit');};
 const string=value=>{add(2);for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);if(n===34||n===92||[8,9,10,12,13].includes(n))add(2);else if(n<32)add(6);else if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new TypeError('Native checkpoint Unicode');add(2);}else if(n>=0xdc00&&n<=0xdfff)throw new TypeError('Native checkpoint Unicode');else add(1);}};
 const walk=(v,depth)=>{if(++nodes>250000||depth>32)throw new RangeError('Native checkpoint state limit');if(v===null){add(4);return;}if(typeof v==='string'){string(v);return;}if(typeof v==='boolean'){add(v?4:5);return;}if(typeof v==='number'){add(Number.isFinite(v)&&!Object.is(v,-0)?String(v).length:JSON.stringify({$asterNumber:Object.is(v,-0)?'-0':String(v)}).length);return;}if(!v||typeof v!=='object'||ancestors.has(v))throw new TypeError('Native checkpoint plain state');const array=Array.isArray(v),proto=Object.getPrototypeOf(v);if(proto!==(array?Array.prototype:Object.prototype)&&!(proto===null&&!array))throw new TypeError('Native checkpoint plain state');const length=array?Object.getOwnPropertyDescriptor(v,'length')?.value:0;if(array&&(!Number.isSafeInteger(length)||length<0||length>65535))throw new RangeError('Native checkpoint record byte limit');const keys=Reflect.ownKeys(v);if(array&&keys.length!==length+1)throw new TypeError('Native checkpoint array shape');ancestors.add(v);add(2);let count=0;for(const key of keys){if(array&&key==='length')continue;if(typeof key!=='string'||['__proto__','prototype','constructor','toJSON','$asterNumber'].includes(key))throw new TypeError('Native checkpoint reserved key');const d=Object.getOwnPropertyDescriptor(v,key);if(!d?.enumerable||!Object.hasOwn(d,'value')||array&&key!==String(count))throw new TypeError('Native checkpoint own data fields');if(count++)add(1);if(!array){string(key);add(1);}walk(d.value,depth+1);}ancestors.delete(v);};
 walk(state,0);return {encodedBytes:chars*2,nodes,logicalBytes:chars*2+nodes*32};
}
function nativeCheckpointText(state){const measured=nativeCheckpointFootprint(state),text=safeCheckpointStringify(state);if(text.length*2!==measured.encodedBytes)throw new TypeError('Native checkpoint serialization changed');return text;}

const nativeCheckpointLedgers=new WeakMap(),nativeCheckpointMaps=new WeakSet(),nativeCheckpointRetired=new WeakSet(),nativeCheckpointEntryOwners=new WeakMap();
function nativeCheckpointCharge(budget,oldBytes,newBytes){const ledger=nativeCheckpointLedgers.get(budget);if(!ledger||!Number.isSafeInteger(oldBytes)||!Number.isSafeInteger(newBytes)||oldBytes<0||newBytes<0||oldBytes>ledger.used||ledger.used-oldBytes>ledger.limit-newBytes)throw new RangeError('Native checkpoint total byte limit');ledger.used+=newBytes-oldBytes;}
class NativeCheckpointBudget {
 constructor(maxBytes=NATIVE_CHECKPOINT_TOTAL_BYTES){if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>NATIVE_CHECKPOINT_TOTAL_BYTES)throw new RangeError('Native checkpoint total byte limit');nativeCheckpointLedgers.set(this,{used:0,limit:maxBytes});}
 get usedBytes(){return nativeCheckpointLedgers.get(this).used;}get maxBytes(){return nativeCheckpointLedgers.get(this).limit;}
}
class NativeCheckpointMap {
 #records=new Map();#bytes=0;#name;#params;#budget;#block;#epoch=0;#closed=false;
 constructor(name,params,{budget=new NativeCheckpointBudget(),block=256}={}){if(typeof name!=='string'||!name||!(budget instanceof NativeCheckpointBudget)||!nativeCheckpointLedgers.has(budget)||!Number.isSafeInteger(block)||block<1||block>nativeCheckpointMaxIndex)throw new TypeError('Native checkpoint context');validateIndicatorParams(params);this.#name=name;this.#params=Object.freeze({...params});this.#budget=budget;this.#block=block;nativeCheckpointMaps.add(this);}
 #check(epoch=this.#epoch){if(this.#closed)throw new Error('Native checkpoint disposed');if(epoch!==this.#epoch){const error=new Error('Native checkpoint changed during validation');error.name='StaleCheckpointError';throw error;}}
 get size(){return this.#records.size;}get encodedBytes(){return this.#bytes;}
 has(index){return this.#records.has(index);}
 get(index){this.#check();const text=this.#records.get(index);return text===undefined?undefined:safeCheckpointParse(text);}
 set(index,state){this.#check();const epoch=this.#epoch;if(!Number.isSafeInteger(index)||index<0||index>nativeCheckpointMaxIndex||index%this.#block)throw new RangeError('Native checkpoint index');const text=nativeCheckpointText(state),owned=safeCheckpointParse(text);validateCheckpointState(this.#name,this.#params,owned,index);if(nativeCheckpointText(owned)!==text)throw new TypeError('Native checkpoint validator mutated state');this.#check(epoch);const oldBytes=(this.#records.get(index)?.length??0)*2,newBytes=text.length*2;nativeCheckpointCharge(this.#budget,oldBytes,newBytes);this.#records.set(index,text);this.#bytes+=newBytes-oldBytes;this.#epoch++;return this;}
 delete(index){this.#epoch++;const text=this.#records.get(index);if(text===undefined)return false;const bytes=text.length*2;nativeCheckpointCharge(this.#budget,bytes,0);this.#records.delete(index);this.#bytes-=bytes;return true;}
 #empty(){this.#epoch++;nativeCheckpointCharge(this.#budget,this.#bytes,0);this.#records.clear();this.#bytes=0;}
 clear(){this.#empty();}
 dispose(){if(this.#closed)return;this.#closed=true;nativeCheckpointRetired.add(this);this.#empty();}
 *keys(){yield* [...this.#records.keys()].sort((a,b)=>a-b);}
 *[Symbol.iterator](){for(const index of this.keys())yield [index,this.get(index)];}
 validateHistory(length){this.#check();const epoch=this.#epoch;if(!Number.isSafeInteger(length)||length<0||length>nativeCheckpointMaxIndex)throw new RangeError('Native checkpoint history length');const expected=length===0?0:Math.floor(length/this.#block)+1;if(this.size!==expected)throw new TypeError('Native checkpoint history count');let i=0;for(const index of this.keys()){if(index!==i++*this.#block)throw new TypeError('Native checkpoint history boundary');const text=this.#records.get(index),state=safeCheckpointParse(text);validateCheckpointState(this.#name,this.#params,state,index);if(nativeCheckpointText(state)!==text)throw new TypeError('Native checkpoint validator mutated state');this.#check(epoch);}this.#check(epoch);return this;}
}

// Only restored engines install this owner map. Retirement never mutates held
// output vectors and never invokes a user-controlled cleanup callback.
const nativeCheckpointDispose=NativeCheckpointMap.prototype.dispose;
function nativeEntryCheckpoints(entry){const value=entry&&Object.getOwnPropertyDescriptor(entry,'checkpoints')?.value;return nativeCheckpointMaps.has(value)?value:null;}
class NativeCheckpointEntries extends Map {
 #byId=new Map();#token={};
 constructor(entries){super();if(entries!==undefined){const staged=new Map();let count=0;for(const [id,entry] of entries){if(++count>128)throw new RangeError('Native checkpoint entry count');staged.set(id,entry);}const rows=[...staged].map(([id,entry])=>[id,entry,nativeEntryCheckpoints(entry)]),seen=new Set();for(const [, ,checkpoints] of rows){if(checkpoints&&(seen.has(checkpoints)||nativeCheckpointRetired.has(checkpoints)||nativeCheckpointEntryOwners.has(checkpoints)))throw new TypeError('Native checkpoint entry ownership');if(checkpoints)seen.add(checkpoints);}for(const [id,entry,checkpoints] of rows)this.#install(id,entry,checkpoints);}}
 #install(id,entry,checkpoints){if(checkpoints){this.#byId.set(id,checkpoints);nativeCheckpointEntryOwners.set(checkpoints,{owner:this.#token,id});}else this.#byId.delete(id);Map.prototype.set.call(this,id,entry);}
 set(id,entry){const next=nativeEntryCheckpoints(entry),previous=this.#byId.get(id),owner=next?nativeCheckpointEntryOwners.get(next):null;if(next&&(nativeCheckpointRetired.has(next)||owner&&(owner.owner!==this.#token||!(owner.id===id||Object.is(owner.id,id)))))throw new TypeError('Native checkpoint entry ownership');if(previous&&previous!==next){nativeCheckpointDispose.call(previous);nativeCheckpointEntryOwners.delete(previous);}this.#install(id,entry,next);return this;}
 delete(id){const previous=this.#byId.get(id),deleted=Map.prototype.delete.call(this,id);if(previous){nativeCheckpointDispose.call(previous);this.#byId.delete(id);nativeCheckpointEntryOwners.delete(previous);}return deleted;}
 clear(){for(const checkpoints of this.#byId.values()){nativeCheckpointDispose.call(checkpoints);nativeCheckpointEntryOwners.delete(checkpoints);}this.#byId.clear();Map.prototype.clear.call(this);}
}

// Compaction keeps the bounded map/owner binding but retires its old records.
// Both validation and commit use private brands, never application methods.
const nativeCheckpointClear=NativeCheckpointMap.prototype.clear,ordinaryCheckpointClear=Map.prototype.clear,ordinaryCheckpointHas=Map.prototype.has;
function ownedCheckpointClear(map){
 if(nativeCheckpointMaps.has(map)){if(nativeCheckpointRetired.has(map)||Object.getPrototypeOf(map)!==NativeCheckpointMap.prototype||Reflect.ownKeys(map).length)throw new TypeError('Compaction requires an active unmodified checkpoint map');return ()=>nativeCheckpointClear.call(map);}
 if(Object.getPrototypeOf(map)!==Map.prototype||Reflect.ownKeys(map).length)throw new TypeError('Compaction requires an unmodified checkpoint Map');
 ordinaryCheckpointHas.call(map,0);return ()=>ordinaryCheckpointClear.call(map);
}

class IngestionError extends Error {
 constructor(code,message,cause){super(message);this.name='IngestionError';this.code=code;if(cause!==undefined)this.cause=cause;}
}

const INGESTION_KINDS=['append','update','correction'],INGESTION_BYTES=49,INGESTION_MAX_EVENTS=4096;
const ingestionPolicyKeys=['streamId','generation','firstSequence','maxQueuedEvents','maxQueuedBytes','maxBatchEvents','maxStoredBars','maxStoreBytes'];
const ingestionCounterKeys=['accepted','applied','cancelled','rejectedPackets','rejectedEvents','failedDrains','peakPendingEvents','peakPendingBytes','lastAppliedSequence','lastCancelledSequence'];
const ingestionModelLeases=new WeakMap();
function assertDataIngestionIdle(model){if(ingestionModelLeases.get(model))throw new IngestionError('BUSY','Model has an active async ingestion fence');}
function acquireDataIngestionLease(model){
 const releaseSession=model.dataIngestion?.acquireLease();ingestionModelLeases.set(model,(ingestionModelLeases.get(model)??0)+1);let released=false;
 return()=>{if(released)return;released=true;try{releaseSession?.();}finally{const remaining=(ingestionModelLeases.get(model)??1)-1;if(remaining)ingestionModelLeases.set(model,remaining);else ingestionModelLeases.delete(model);}};
}
function dataIngestionBatchLimits(model,event,length,capacity){
 if(event?.kind!=='batch'||!model.dataIngestion)return null;
 const policy=model.dataIngestion.policy;
 if(length===undefined){length=model.store.length+event.events.reduce((n,e)=>n+Number(e.kind==='append'),0);capacity=model.store.capacity;while(capacity<length)capacity*=2;}
 if(length>policy.maxStoredBars||96*capacity>policy.maxStoreBytes)throw new IngestionError('STORE_BUDGET','Batch exceeds configured stored-row/capacity-byte budget');
 return {maxBars:policy.maxStoredBars,maxStoreBytes:policy.maxStoreBytes};
}
// Snapshot only own data descriptors. Getters are not invoked. Proxy traps may
// still reenter, so each mutating caller checks owner/source identity afterwards.
function ingestionRecord(value,keys,label){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new IngestionError('INVALID_INPUT',label+' object required');
 const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)throw new IngestionError('INVALID_INPUT',label+' plain object required');
 const result={};for(const key of Reflect.ownKeys(value)){
  if(typeof key!=='string'||!keys.includes(key))throw new IngestionError('INVALID_INPUT',label+' unsupported field');
  const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new IngestionError('INVALID_INPUT',label+' data properties required');
  result[key]=descriptor.value;
 }return result;
}
function ingestionInteger(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new IngestionError('INVALID_INPUT',label+' integer range');return value;}
function snapshotIngestionEvents(input){
 if(!Array.isArray(input))throw new IngestionError('INVALID_INPUT','1–4096 ordered events required');
 const count=Object.getOwnPropertyDescriptor(input,'length')?.value;
 if(!Number.isSafeInteger(count)||count<1||count>INGESTION_MAX_EVENTS)throw new IngestionError('INVALID_INPUT','1–4096 ordered events required');
 const keys=Reflect.ownKeys(input);if(keys.length!==count+1||keys.some(k=>k!=='length'&&(typeof k!=='string'||!Number.isSafeInteger(Number(k))||String(Number(k))!==k||Number(k)<0||Number(k)>=count)))throw new IngestionError('INVALID_INPUT','Dense event array required');
 const result=[];for(let i=0;i<count;i++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(i));if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new IngestionError('INVALID_INPUT','Event array data entries required');
  const row=ingestionRecord(descriptor.value,['kind','bar'],'Event');if(!INGESTION_KINDS.includes(row.kind))throw new IngestionError('INVALID_INPUT','Ordered append/update/correction required');
  const bar=ingestionRecord(row.bar,FIELDS,'OHLCV');try{validateBar(bar);}catch(cause){throw new IngestionError('INVALID_INPUT',cause.message,cause);}result.push({kind:row.kind,bar});
 }if(Object.getOwnPropertyDescriptor(input,'length')?.value!==count)throw new IngestionError('INVALID_INPUT','Event array length changed during snapshot');return result;
}
function ingestionPolicy(model,input,allowBudgetMismatch=false){
 const row=ingestionRecord(input,ingestionPolicyKeys,'Ingestion policy');try{identifier(row.streamId,'Stream id');}catch(cause){throw new IngestionError('INVALID_INPUT',cause.message,cause);}
 const policy={streamId:row.streamId,generation:row.generation,firstSequence:row.firstSequence??0,maxQueuedEvents:row.maxQueuedEvents??4096,maxQueuedBytes:row.maxQueuedBytes??262144,maxBatchEvents:row.maxBatchEvents??128,maxStoredBars:row.maxStoredBars??model.store.maxBars,maxStoreBytes:row.maxStoreBytes??96*RESOURCE_LIMITS.maxBars};
 for(const key of ['generation','firstSequence'])ingestionInteger(policy[key],0,Number.MAX_SAFE_INTEGER,key);
 ingestionInteger(policy.maxQueuedEvents,1,4096,'maxQueuedEvents');ingestionInteger(policy.maxQueuedBytes,49,16777216,'maxQueuedBytes');ingestionInteger(policy.maxBatchEvents,1,4096,'maxBatchEvents');
 ingestionInteger(policy.maxStoredBars,0,model.store.maxBars,'maxStoredBars');ingestionInteger(policy.maxStoreBytes,1536,96*RESOURCE_LIMITS.maxBars,'maxStoreBytes');
 if(!allowBudgetMismatch&&(model.store.length>policy.maxStoredBars||model.store.bytes>policy.maxStoreBytes))throw new IngestionError('STORE_BUDGET','Current history exceeds ingestion admission budget');return Object.freeze(policy);
}
function ingestionLastError(value){if(value===null)return null;const row=ingestionRecord(value,['code','message'],'Last error');if(typeof row.code!=='string'||!/^[A-Z_]{1,64}$/.test(row.code)||typeof row.message!=='string'||row.message.length>256)throw new IngestionError('INVALID_DOCUMENT','Last error shape');return {...row};}

/** Internal model-owned state. The host schedules drains; no timers or feeds. */
class DataIngestion {
 constructor(model,options,{allowBudgetMismatch=false}={}){
  const source=model.store,version=source.version,owner=model.dataIngestion;
  this.policy=ingestionPolicy(model,options,allowBudgetMismatch);this.model=model;this.store=source;this.sourceVersion=version;this.head=0;this.count=0;
  this.capacity=Math.min(this.policy.maxQueuedEvents,Math.floor(this.policy.maxQueuedBytes/INGESTION_BYTES));
  this.columns=Object.fromEntries(FIELDS.map(k=>[k,new Float64Array(this.capacity)]));this.kinds=new Uint8Array(this.capacity);
  this.nextSequence=this.policy.firstSequence;this.firstPendingSequence=this.nextSequence;this.paused=false;this.draining=false;this.leased=false;this.closed=false;this.lastError=null;this.epoch=0;
  this.counters={accepted:0,applied:0,cancelled:0,rejectedPackets:0,rejectedEvents:0,failedDrains:0,peakPendingEvents:0,peakPendingBytes:0,lastAppliedSequence:null,lastCancelledSequence:null};
  if(model.disposed||model.store!==source||source.version!==version||model.dataIngestion!==owner)throw new IngestionError('SOURCE_CHANGED','Owner changed while configuring ingestion');
 }
 active(){if(this.closed||!this.model||this.model.disposed||this.model.dataIngestion!==this)throw new IngestionError('CLOSED','Ingestion session closed or replaced');}
 idle(){this.active();if(this.leased||this.draining)throw new IngestionError('BUSY','Ingestion has an active async lease or drain');}
 source(){
  this.active();if(this.model.store!==this.store||this.store.version!==this.sourceVersion){
   if(this.count){this.paused=true;this.lastError={code:'SOURCE_CHANGED',message:'Source changed outside ingestion while payload is pending'};throw new IngestionError(this.lastError.code,this.lastError.message);}
   this.store=this.model.store;this.sourceVersion=this.store.version;
  }
 }
 rejection(error,count=0){if(!this.closed){if(this.counters.rejectedPackets<Number.MAX_SAFE_INTEGER)this.counters.rejectedPackets++;this.counters.rejectedEvents=Math.min(Number.MAX_SAFE_INTEGER,this.counters.rejectedEvents+count);}throw error instanceof IngestionError?error:new IngestionError('INVALID_INPUT',String(error.message).slice(0,256),error);}
 enqueue(packet){
  let events=[];try{
   this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');if(this.paused)throw new IngestionError('PAUSED','Ingestion paused');this.source();
   const version=this.store.version,next=this.nextSequence,epoch=this.epoch,row=ingestionRecord(packet,['streamId','generation','firstSequence','events'],'Packet');events=snapshotIngestionEvents(row.events);
   this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');if(this.paused)throw new IngestionError('PAUSED','Ingestion paused');this.source();
   if(this.store.version!==version||this.nextSequence!==next||this.epoch!==epoch)throw new IngestionError('SOURCE_CHANGED','Owner/cursor changed during packet snapshot');
   if(row.streamId!==this.policy.streamId||row.generation!==this.policy.generation)throw new IngestionError('STREAM_MISMATCH','Packet stream/generation mismatch');
   ingestionInteger(row.firstSequence,0,Number.MAX_SAFE_INTEGER,'firstSequence');if(row.firstSequence!==this.nextSequence)throw new IngestionError('SEQUENCE_MISMATCH','Packet firstSequence must equal nextSequence');
   if(events.length>this.capacity-this.count)throw new IngestionError('QUEUE_BUDGET','Packet exceeds queued event/typed-byte budget');
   if(this.nextSequence>Number.MAX_SAFE_INTEGER-events.length||this.counters.accepted>Number.MAX_SAFE_INTEGER-events.length)throw new IngestionError('SEQUENCE_LIMIT','Sequence/counter limit');
   for(let i=0;i<events.length;i++){const at=(this.head+this.count+i)%this.capacity,e=events[i];for(const k of FIELDS)this.columns[k][at]=e.bar[k];this.kinds[at]=INGESTION_KINDS.indexOf(e.kind);}
   const firstSequence=this.nextSequence;if(!this.count)this.firstPendingSequence=firstSequence;this.count+=events.length;this.nextSequence+=events.length;this.counters.accepted+=events.length;this.epoch++;
   this.counters.peakPendingEvents=Math.max(this.counters.peakPendingEvents,this.count);this.counters.peakPendingBytes=this.counters.peakPendingEvents*INGESTION_BYTES;
   return {events:events.length,firstSequence,nextSequence:this.nextSequence,pendingEvents:this.count,pendingBytes:this.count*INGESTION_BYTES};
  }catch(error){return this.rejection(error,events.length);}
 }
 prefix(count=this.count){const result=[];for(let i=0;i<count;i++){const at=(this.head+i)%this.capacity;result.push({kind:INGESTION_KINDS[this.kinds[at]],bar:Object.fromEntries(FIELDS.map(k=>[k,this.columns[k][at]]))});}return result;}
 drain(maxEvents=this.policy.maxBatchEvents){
  this.idle();if(this.paused)throw new IngestionError('PAUSED','Ingestion paused');this.source();ingestionInteger(maxEvents,1,this.policy.maxBatchEvents,'Drain count');
  if(!this.count)return {events:0,appended:0,from:this.store.length,to:this.store.length,version:this.store.version,length:this.store.length,capacity:this.store.capacity,bytes:this.store.bytes,firstSequence:null,lastSequence:null};
  const n=Math.min(maxEvents,this.count),events=this.prefix(n),firstSequence=this.firstPendingSequence;this.draining=true;let committed=false;
  try{
   if(events.some(e=>e.kind==='append')&&this.model.series.some(s=>s.values))throw new IngestionError('EXTERNAL_ALIGNMENT','Length-changing ingestion requires host realignment of external values');
   const receipt=this.store._applyEvents(events,{maxBars:this.policy.maxStoredBars,maxStoreBytes:this.policy.maxStoreBytes},()=>{
    // Pure/no-throw ledger commit before the store's observer publication. No
    // callbacks occur here; nested enqueue/cancel sees already-applied payload.
    this.head=(this.head+n)%this.capacity;this.count-=n;this.firstPendingSequence+=n;this.counters.applied+=n;this.counters.lastAppliedSequence=firstSequence+n-1;this.sourceVersion=this.store.version+1;this.epoch++;committed=true;
   });return {...receipt,firstSequence,lastSequence:firstSequence+n-1};
  }catch(cause){
   if(committed)throw cause;
   this.counters.failedDrains=Math.min(Number.MAX_SAFE_INTEGER,this.counters.failedDrains+1);this.paused=true;this.lastError={code:'DRAIN_FAILED',message:String(cause.message).slice(0,256)};throw new IngestionError('DRAIN_FAILED',this.lastError.message,cause);
  }finally{this.draining=false;}
 }
 pause(){this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');this.paused=true;this.epoch++;return this.stats();}
 resume(){this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');this.store=this.model.store;this.sourceVersion=this.store.version;this.paused=false;this.lastError=null;this.epoch++;return this.stats();}
 cancel(){this.active();if(this.leased)throw new IngestionError('BUSY','Async ingestion lease active');const events=this.count,firstSequence=events?this.firstPendingSequence:null,lastSequence=events?firstSequence+events-1:null;this.counters.cancelled+=events;if(events)this.counters.lastCancelledSequence=lastSequence;this.count=0;this.head=0;this.firstPendingSequence=this.nextSequence;this.epoch++;return {events,firstSequence,lastSequence};}
 sourceStatus(){const changed=this.count>0&&(this.model.store!==this.store||this.store.version!==this.sourceVersion);return {paused:this.paused||changed,lastError:changed?{code:'SOURCE_CHANGED',message:'Source changed outside ingestion while payload is pending'}:this.lastError?{...this.lastError}:null};}
 stats(){this.active();const status=this.sourceStatus();return {policy:{...this.policy},state:this.leased||this.draining?'busy':status.paused?'paused':'running',nextSequence:this.nextSequence,...this.counters,pendingEvents:this.count,pendingBytes:this.count*INGESTION_BYTES,ownedBytes:this.capacity*INGESTION_BYTES,lastError:status.lastError,storedBars:this.model.store.length,storeBytes:this.model.store.bytes};}
 save(){this.active();const status=this.sourceStatus();return safeCheckpointStringify({schema:'aster.ingestion',version:1,policy:{...this.policy},state:status.paused?'paused':'running',nextSequence:this.nextSequence,counters:{...this.counters},lastError:status.lastError,pending:{firstSequence:this.firstPendingSequence,events:this.prefix()}});}
 acquireLease(){this.idle();if(this.count)throw new IngestionError('PENDING_DATA','Drain or cancel pending data before async preparation');this.leased=true;this.epoch++;let released=false;return()=>{if(!released){released=true;this.leased=false;this.epoch++;}};}
 dispose(){if(this.closed)return;this.counters.cancelled+=this.count;if(this.count)this.counters.lastCancelledSequence=this.firstPendingSequence+this.count-1;this.count=0;this.head=0;this.firstPendingSequence=this.nextSequence;this.closed=true;this.leased=false;this.columns={};this.kinds=null;this.model=null;this.store=null;}
}
function restoreDataIngestion(model,text,{allowBudgetMismatch=false}={}){
 const owner=model.dataIngestion,source=model.store,version=source.version;
 const doc=ingestionRecord(safeCheckpointParse(text),['schema','version','policy','state','nextSequence','counters','lastError','pending'],'Ingestion document');
 if(doc.schema!=='aster.ingestion'||doc.version!==1||!['running','paused'].includes(doc.state))throw new IngestionError('INVALID_DOCUMENT','Ingestion schema/version/state');
 const candidate=new DataIngestion(model,doc.policy,{allowBudgetMismatch});try{
  const counters=ingestionRecord(doc.counters,ingestionCounterKeys,'Counters');for(const key of ingestionCounterKeys){if(key.startsWith('last')){if(counters[key]!==null)ingestionInteger(counters[key],0,Number.MAX_SAFE_INTEGER,key);}else ingestionInteger(counters[key],0,Number.MAX_SAFE_INTEGER,key);}
  const pending=ingestionRecord(doc.pending,['firstSequence','events'],'Pending');if(!Array.isArray(pending.events)||pending.events.length>candidate.capacity)throw new IngestionError('INVALID_DOCUMENT','Pending count');
  ingestionInteger(doc.nextSequence,0,Number.MAX_SAFE_INTEGER,'Next sequence');ingestionInteger(pending.firstSequence,0,Number.MAX_SAFE_INTEGER,'Pending sequence');
  if(counters.accepted!==counters.applied+counters.cancelled+pending.events.length||candidate.policy.firstSequence+counters.accepted!==doc.nextSequence||pending.firstSequence+pending.events.length!==doc.nextSequence||counters.peakPendingEvents<pending.events.length||counters.peakPendingEvents>candidate.capacity||counters.peakPendingBytes!==counters.peakPendingEvents*INGESTION_BYTES||['lastAppliedSequence','lastCancelledSequence'].some(k=>counters[k]!==null&&(counters[k]<candidate.policy.firstSequence||counters[k]>=doc.nextSequence)))throw new IngestionError('INVALID_DOCUMENT','Ingestion cursor/counter conservation');
  for(const [count,key] of [[counters.applied,'lastAppliedSequence'],[counters.cancelled,'lastCancelledSequence']])if(count===0?counters[key]!==null:counters[key]===null||counters[key]<candidate.policy.firstSequence+count-1||counters[key]>=pending.firstSequence)throw new IngestionError('INVALID_DOCUMENT','Ingestion completed cursor');
  const completed=counters.applied+counters.cancelled;if(completed&&Math.max(counters.lastAppliedSequence??-1,counters.lastCancelledSequence??-1)!==pending.firstSequence-1||counters.applied>0&&counters.cancelled>0&&counters.lastAppliedSequence===counters.lastCancelledSequence||counters.accepted>0&&counters.peakPendingEvents===0||counters.failedDrains>0&&counters.accepted===0||counters.rejectedPackets===0&&counters.rejectedEvents!==0||counters.rejectedEvents>counters.rejectedPackets*4096)throw new IngestionError('INVALID_DOCUMENT','Ingestion history/counter bounds');
  const events=pending.events.length?snapshotIngestionEvents(pending.events):[];for(let i=0;i<events.length;i++){for(const k of FIELDS)candidate.columns[k][i]=events[i].bar[k];candidate.kinds[i]=INGESTION_KINDS.indexOf(events[i].kind);}
  candidate.count=events.length;candidate.firstPendingSequence=pending.firstSequence;candidate.nextSequence=doc.nextSequence;candidate.counters={...counters};candidate.paused=doc.state==='paused';candidate.lastError=ingestionLastError(doc.lastError);
  if(!candidate.paused&&candidate.lastError!==null)throw new IngestionError('INVALID_DOCUMENT','Running ingestion cannot retain a paused error');
  if(model.disposed||model.dataIngestion!==owner||model.store!==source||source.version!==version)throw new IngestionError('SOURCE_CHANGED','Owner changed during ingestion restoration');return candidate;
 }catch(error){candidate.dispose();throw error;}
}


function studyPick(value,keys){return Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));}
function studyModuleEqual(a,b){return a===undefined&&b===undefined||!!a&&!!b&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));}
function studyConfigurationKey(model){return JSON.stringify({definitions:[...model.indicators.entries].map(([id,e])=>[id,e.name,e.params]),series:model.series.map(s=>studyPick(s,SERIES_KEYS.filter(k=>k!=='values'))),panels:model.panels,axes:model.axes,valuesRevision:model.seriesValuesRevision??0});}
function saveStudySetup(model){
 if(model.disposed)throw new Error('Chart disposed');
 const indicators=[...model.indicators.entries].map(([id,e])=>{requirePortableFactory(e.name,model.indicators.registry.get(e.name));validateIndicatorParams(e.params);const module=indicatorModule(e.name);return {id,name:e.name,params:{...e.params},...(module?{module}:{})};});
 // Low-level renderers allow broader CSS than portable study documents.
 // Validate the detached export styles without rewriting live or saved values.
 const series=model.series.filter(s=>s.indicator).map(s=>{const copy=studyPick(s,SERIES_KEYS.filter(k=>k!=='values'));portableStyle(copy,['color','fill','upColor','downColor'],true);return copy;});
 // Use the reader's bounded codec so every successful save is readable and
 // finite parameter -0 keeps its observable sign across module restoration.
 return safeCheckpointStringify({schema:'aster.studies',version:1,indicators,series});
}
// Synchronous atomic parameter replacement. This preserves visual bindings;
// changed output layout/offsets require an explicit remove/reconfigure operation.
function setStudyParams(model,id,params){
 if(model.disposed)throw new Error('Chart disposed');
 const engine=model.indicators,store=model.store,version=store.version,entriesMap=engine.entries,registryMap=engine.registry,entry=entriesMap.get(id);
 if(!entry)throw new Error('Missing indicator');
 const entries=[...entriesMap],registry=[...registryMap],series=model.series,bindings=series.slice(),key=studyConfigurationKey(model);
 const current=()=>!model.disposed&&model.indicators===engine&&model.store===store&&store.version===version&&engine.entries===entriesMap&&engine.registry===registryMap&&model.series===series&&series.length===bindings.length&&bindings.every((s,i)=>series[i]===s)&&entries.length===entriesMap.size&&entries.every(([k,e])=>entriesMap.get(k)===e)&&registry.length===registryMap.size&&registry.every(([k,f])=>registryMap.get(k)===f)&&studyConfigurationKey(model)===key;
 validateIndicatorParams(params);const requested={...params};validateIndicatorParams(requested);
 if(!current())throw new Error('Indicator params stale: owner changed during snapshot');
 const same=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));
 const metadata=def=>({outputs:[...def.outputs],plotOffsets:{...def.plotOffsets}});
 if(same(entry.params,requested)){const result=metadata(entry.def);if(!current())throw new Error('Indicator params stale: owner changed during metadata');return result;}
 const candidate=new IndicatorEngine(store,{checkpointSize:engine.checkpointSize,maxOutputBytes:engine.maxOutputBytes});
 candidate.registry=new Map(registry);candidate.entries=new Map(entries);candidate.entries.delete(id);
 try{
  candidate.add(id,entry.name,{...requested});const replacement=candidate.entries.get(id);
  validateIndicatorParams(replacement.params);
  if(!same(replacement.params,requested))throw new TypeError('Indicator factory changed requested params');
  if(entry.def.outputs.length!==replacement.def.outputs.length||entry.def.outputs.some((output,i)=>output!==replacement.def.outputs[i]))throw new TypeError('Indicator parameter update cannot change output schema');
  const offset=(def,output)=>def.plotOffsets&&Object.hasOwn(def.plotOffsets,output)?def.plotOffsets[output]:0;
  if(entry.def.outputs.some(output=>!Object.is(offset(entry.def,output),offset(replacement.def,output))))throw new TypeError('Indicator parameter update cannot change plot offsets');
  const result=metadata(replacement.def);
  if(!current())throw new Error('Indicator params stale: owner changed during staging');
  entriesMap.set(id,replacement);
  for(const s of series)if(s.indicator===id){s.rangeIndex=null;s.revision=undefined;s.dirtyFrom=0;}
  return result;
 }finally{candidate.dispose();}
}
// Atomic additive import. Data, layout, existing studies and drawing history are
// host-owned; all required panel/axis bindings must already exist.
function loadStudySetup(model,text){
 if(model.disposed)throw new Error('Chart disposed');
 const doc=safeCheckpointParse(text);optionRecord(doc,['schema','version','indicators','series'],'Study setup');
 if(doc.schema!=='aster.studies'||doc.version!==1||!Array.isArray(doc.indicators)||!Array.isArray(doc.series)||doc.indicators.length>RESOURCE_LIMITS.maxIndicators||doc.series.length>RESOURCE_LIMITS.maxSeries)throw new TypeError('Study setup schema/count');
 if(model.indicators.entries.size+doc.indicators.length>RESOURCE_LIMITS.maxIndicators||model.series.length+doc.series.length>RESOURCE_LIMITS.maxSeries)throw new RangeError('Study setup capacity');
 const store=model.store,version=store.version,engine=model.indicators,entriesMap=engine.entries,registryMap=engine.registry,entries=[...engine.entries],registry=[...engine.registry],series=model.series,key=studyConfigurationKey(model);
 const candidate=new IndicatorEngine(store,{checkpointSize:engine.checkpointSize,maxOutputBytes:engine.maxOutputBytes});candidate.registry=new Map(engine.registry);candidate.entries=new Map(engine.entries);
 try{
  const ids=new Set();
  for(const e of doc.indicators){
   optionRecord(e,['id','name','params','module'],'Study definition');validateIndicatorParams(e.params);if(ids.has(e.id)||engine.entries.has(e.id))throw new Error('Duplicate study id');ids.add(e.id);
   requirePortableFactory(e.name,candidate.registry.get(e.name));const expected=indicatorModule(e.name);if(!studyModuleEqual(e.module,expected))throw new TypeError('Study module version/codec mismatch');
   candidate.add(e.id,e.name,e.params);
  }
  const proxy=Object.create(model);proxy.indicators=candidate;const seriesIds=new Set(model.series.map(s=>s.id)),added=[];
  for(const s of doc.series){optionRecord(s,SERIES_KEYS.filter(k=>k!=='values'),'Study series');if(!ids.has(s.indicator))throw new Error('Study series requires an imported indicator');if(seriesIds.has(s.id))throw new Error('Duplicate study series id');seriesIds.add(s.id);added.push(proxy.normalizedSeries(portableStyle(s,['color','fill','upColor','downColor'],true)));}
  if(model.disposed||model.store!==store||store.version!==version||model.indicators!==engine||engine.entries!==entriesMap||engine.registry!==registryMap||model.series!==series||studyConfigurationKey(model)!==key||entries.length!==engine.entries.size||entries.some(([id,e])=>engine.entries.get(id)!==e)||registry.length!==engine.registry.size||registry.some(([name,f])=>engine.registry.get(name)!==f))throw new Error('Study setup stale: owner changed during staging');
  for(const id of ids)engine.entries.set(id,candidate.entries.get(id));model.series=series.concat(added);
  return {indicators:ids.size,series:added.length};
 }finally{candidate.dispose();}
}


const explorerTyped=Object.getPrototypeOf(Float64Array.prototype),explorerTypedLength=Object.getOwnPropertyDescriptor(explorerTyped,'length').get,explorerTypedBuffer=Object.getOwnPropertyDescriptor(explorerTyped,'buffer').get,explorerTypedTag=Object.getOwnPropertyDescriptor(explorerTyped,Symbol.toStringTag).get;
const explorerArrayBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const explorerMapEntries=Map.prototype.entries,explorerMapGet=Map.prototype.get,explorerMapSize=Object.getOwnPropertyDescriptor(Map.prototype,'size').get;
function explorerSlot(object,key,required=false){const d=Object.getOwnPropertyDescriptor(object,key);if(!d){if(required)throw new TypeError('Data query missing '+key);return undefined;}if(!Object.hasOwn(d,'value'))throw new TypeError('Data query own data properties required');return d.value;}
function explorerRecord(value,keys,label){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' plain record');const out=Object.create(null);for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||!keys.includes(key))throw new TypeError(label+' fields');const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' own data fields');Object.defineProperty(out,key,{value:d.value,enumerable:true});}return out;}
function explorerList(value,max,label){if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError(label+' array');const n=explorerSlot(value,'length',true);if(n>max||Reflect.ownKeys(value).length!==n+1)throw new RangeError(label+' limit/shape');return Array.from({length:n},(_,i)=>explorerSlot(value,String(i),true));}
function explorerVector(value,length){if(explorerTypedTag.call(value)!=='Float64Array'||explorerTypedLength.call(value)<length)throw new TypeError('Data query Float64 column length');const buffer=explorerTypedBuffer.call(value);try{explorerArrayBufferLength.call(buffer);}catch{throw new TypeError('Shared data query buffer');}return value;}
function explorerCapture(object,keys){if(!object||typeof object!=='object')throw new TypeError('Data query owner object');return {object,values:keys.map(key=>[key,explorerSlot(object,key)])};}
function explorerSame(snapshot){return snapshot.values.every(([key,value])=>{const d=Object.getOwnPropertyDescriptor(snapshot.object,key);return d?Object.hasOwn(d,'value')&&Object.is(d.value,value):value===undefined;});}
function explorerText(value,max,label,nullable=false){if(nullable&&value==null)return null;boundedText(value,max,label);return value;}
function explorerStale(){const error=new Error('Data query source or display configuration changed');error.name='StaleSourceError';throw error;}
function explorerMapSnapshot(value,max){const n=explorerMapSize.call(value);if(n>max)throw new RangeError('Data query indicator limit');return [...explorerMapEntries.call(value)];}
function explorerMapSame(value,rows){return explorerMapSize.call(value)===rows.length&&rows.every(([key,entry])=>explorerMapGet.call(value,key)===entry);}

// A reentrant source update can invalidate an in-flight engine calculation,
// whose normal completion would otherwise overwrite that dirty marker. Only
// the still-owned entry is reset; replaced/disposed owners are never revived.
function explorerInvalidateCalculation(model,engine,entries,id,entry,source,columnOwner){
 if(explorerSame(source)&&explorerSame(columnOwner))return;
 if(explorerSlot(model,'disposed')||explorerSlot(model,'indicators')!==engine||explorerSlot(engine,'entries')!==entries||explorerMapGet.call(entries,id)!==entry)return;
 const dirty=Object.getOwnPropertyDescriptor(entry,'dirty'),invalidated=Object.getOwnPropertyDescriptor(entry,'invalidated');
 if(!dirty||!Object.hasOwn(dirty,'value')||!dirty.writable||!invalidated||!Object.hasOwn(invalidated,'value')||!invalidated.writable)return;
 Object.defineProperty(entry,'dirty',{value:0});Object.defineProperty(entry,'invalidated',{value:true});
}

// A bounded semantic readout, independent of layout, viewport and pixels. Lazy
// indicator evaluation can update caches and execute trusted application code.
function dataAt(model,query,options={}){
 const q=explorerRecord(query,['index','time','match'],'Data selection'),o=explorerRecord(options,['asOfIndex','includeHidden'],'Data query options');
 const byIndex=Object.hasOwn(q,'index');
 if(byIndex){if(Object.keys(q).length!==1||!Number.isSafeInteger(q.index)||q.index<0)throw new RangeError('Data query index');}
 else if(Object.keys(q).length!==2||!Object.hasOwn(q,'time')||!Object.hasOwn(q,'match')||!Number.isSafeInteger(q.time)||Math.abs(q.time)>8640000000000000||!['exact','at-or-before'].includes(q.match))throw new RangeError('Data query time and explicit match');
 if(o.includeHidden!==undefined&&typeof o.includeHidden!=='boolean')throw new TypeError('Data query hidden flag');
 const owner=explorerCapture(model,['disposed','store','indicators','series','panels','axes','symbol','seriesValuesRevision','seriesValueRevisions']),store=explorerSlot(model,'store',true),engine=explorerSlot(model,'indicators',true);
 if(explorerSlot(model,'disposed'))throw new Error('Chart disposed');if(!(store instanceof BarStore)||!(engine instanceof IndicatorEngine))throw new TypeError('Data query managed store/indicators');
 const source=explorerCapture(store,['length','capacity','version','timeVersion','columns']),length=explorerSlot(store,'length',true),columns=explorerSlot(store,'columns',true),version=explorerSlot(store,'version',true);
 if(!Number.isSafeInteger(length)||length<0||length>RESOURCE_LIMITS.maxBars)throw new RangeError('Data query source length');
 const cutoff=o.asOfIndex===undefined?length-1:o.asOfIndex;if(!Number.isSafeInteger(cutoff)||cutoff< -1||cutoff>=length)throw new RangeError('Data query cutoff');
 const columnOwner=explorerCapture(columns,FIELDS),vectors=FIELDS.map(key=>explorerVector(explorerSlot(columns,key,true),length));
 const seriesList=explorerSlot(model,'series',true),series=explorerList(seriesList,RESOURCE_LIMITS.maxSeries,'Data query series'),seriesState=series.map(s=>explorerCapture(s,SERIES_KEYS));
 const panelsList=explorerSlot(model,'panels',true),panels=explorerList(panelsList,RESOURCE_LIMITS.maxPanels,'Data query panels'),panelState=panels.map(p=>explorerCapture(p,PANEL_KEYS));
 const axesList=explorerSlot(model,'axes',true),axes=explorerList(axesList,RESOURCE_LIMITS.maxAxes,'Data query axes'),axisState=axes.map(a=>explorerCapture(a,AXIS_KEYS));
 const engineOwner=explorerCapture(engine,['entries','registry']),entries=explorerSlot(engine,'entries',true),registry=explorerSlot(engine,'registry',true),entryRows=explorerMapSnapshot(entries,RESOURCE_LIMITS.maxIndicators),factoryRows=entryRows.map(([,entry])=>{const name=explorerSlot(entry,'name',true);return [name,explorerMapGet.call(registry,name)];});
 const entryState=entryRows.map(([,e])=>explorerCapture(e,['def','name','params']));
 const definitionState=entryRows.map(([,entry])=>{const def=explorerSlot(entry,'def',true),schema=explorerSlot(def,'outputs',true),keys=explorerList(schema,32,'Data query outputs'),offsets=explorerSlot(def,'plotOffsets'),params=explorerSlot(entry,'params',true);const offsetKeys=offsets==null?[]:Reflect.ownKeys(offsets),paramKeys=Reflect.ownKeys(params);if(offsetKeys.length>32||paramKeys.length>32||offsetKeys.some(k=>typeof k!=='string')||paramKeys.some(k=>typeof k!=='string'))throw new RangeError('Data query definition metadata');return {def:explorerCapture(def,['create','outputs','plotOffsets']),schema:explorerCapture(schema,['length',...keys.map((_,i)=>String(i))]),offsets:offsets==null?null:explorerCapture(offsets,offsetKeys),params:explorerCapture(params,paramKeys),offsetKeys:offsetKeys.length,paramKeys:paramKeys.length};});
 const symbol=explorerSlot(model,'symbol'),symbolState=symbol?explorerCapture(symbol,['id','currency','volumeUnit']):null;
 const primarySymbol=symbol?{id:explorerText(explorerSlot(symbol,'id',true),128,'Symbol id'),currency:explorerText(explorerSlot(symbol,'currency',true),64,'Currency'),volumeUnit:explorerText(explorerSlot(symbol,'volumeUnit',true),64,'Volume unit')}:null;
 const guard=()=>{if(!explorerSame(owner)||explorerSlot(model,'disposed')||!explorerSame(source)||!explorerSame(columnOwner)||!explorerSame(engineOwner)||!explorerMapSame(entries,entryRows)||!factoryRows.every(([name,factory])=>explorerMapGet.call(registry,name)===factory)||!entryState.every(explorerSame)||!definitionState.every(s=>explorerSame(s.def)&&explorerSame(s.schema)&&(!s.offsets||explorerSame(s.offsets)&&Reflect.ownKeys(s.offsets.object).length===s.offsetKeys)&&explorerSame(s.params)&&Reflect.ownKeys(s.params.object).length===s.paramKeys)||symbolState&&!explorerSame(symbolState)||explorerSlot(seriesList,'length')!==series.length||series.some((s,i)=>explorerSlot(seriesList,String(i))!==s)||!seriesState.every(explorerSame)||explorerSlot(panelsList,'length')!==panels.length||panels.some((p,i)=>explorerSlot(panelsList,String(i))!==p)||!panelState.every(explorerSame)||explorerSlot(axesList,'length')!==axes.length||axes.some((a,i)=>explorerSlot(axesList,String(i))!==a)||!axisState.every(explorerSame))explorerStale();};
 let index=q.index;
 if(!byIndex){let lo=0,hi=length;const time=vectors[0];while(lo<hi){const mid=(lo+hi)>>>1;if(time[mid]<q.time)lo=mid+1;else hi=mid;}index=lo<length&&time[lo]===q.time?lo:q.match==='at-or-before'?lo-1:-1;}
 if(index<0||index>=length||index>cutoff){guard();return null;}
 const bar=Object.fromEntries(FIELDS.map((key,i)=>[key,vectors[i][index]]));validateBar(bar);
 const pending=[];
 for(let i=0;i<series.length;i++){
  const s=series[i],v=Object.fromEntries(seriesState[i].values);if(v.visible===false&&!o.includeHidden)continue;
  identifier(v.id,'Series id');identifier(v.panel,'Series panel');if(v.axisId!=null)identifier(v.axisId,'Series axis');
  if(!panels.some(p=>explorerSlot(p,'id')===v.panel)||v.axisId!=null&&!axes.some(a=>explorerSlot(a,'id')===v.axisId&&explorerSlot(a,'panel')===v.panel))throw new TypeError('Data query series binding');
  const offset=v.offset??0;if(!Number.isSafeInteger(offset)||Math.abs(offset)>10000)throw new RangeError('Data query series offset');
  const sourceIndex=index-offset,kind=v.values?'external':v.indicator?'indicator':'source';
  const row={id:v.id,label:explorerText(v.label??v.id,256,'Series label'),panel:v.panel,axisId:v.axisId??null,symbolId:v.values?explorerText(v.symbolId,128,'External symbol',true):primarySymbol?.id??null,visible:v.visible!==false,type:explorerText(v.type,16,'Series type'),kind,causality:kind==='source'?'stored-source':kind==='external'?'host-aligned':'unverified-study',offset,source:kind==='source'?(v.source??'close'):null,indicator:kind==='indicator'?explorerText(v.indicator,128,'Indicator id'):null,output:kind==='indicator'?(v.output??null):null,value:null,sourceIndex:null,sourceTime:null,status:'outside-source'};
  if(row.source!==null&&!FIELDS.includes(row.source))throw new TypeError('Data query source field');
  let entry=null,key=null;
  if(kind==='indicator'){
   entry=explorerMapGet.call(entries,v.indicator);if(!entry)throw new Error('Missing indicator');const def=explorerSlot(entry,'def',true),outputs=explorerList(explorerSlot(def,'outputs',true),128,'Data query outputs');key=v.output??outputs[0];explorerText(key,128,'Indicator output');if(!outputs.includes(key))throw new Error('Missing indicator output');row.output=key;try{if(requirePortableFactory(explorerSlot(entry,'name',true),explorerMapGet.call(registry,explorerSlot(entry,'name',true)))===null&&isCanonicalBuiltinDefinition(explorerSlot(entry,'name',true),def))row.causality='canonical-builtin';}catch{}
  }
  if(sourceIndex<0||sourceIndex>=length){pending.push({row});continue;}
  if(sourceIndex>cutoff){row.status='after-cutoff';pending.push({row});continue;}
  if(entry&&cutoff<length-1&&row.causality!=='canonical-builtin'){row.status='unsupported-causality';pending.push({row});continue;}
  pending.push({row,sourceIndex,array:kind==='external'?explorerVector(v.values,length):kind==='source'?vectors[FIELDS.indexOf(row.source)]:null,entry,key});
 }
 // Validate every selected binding before the first lazy callback. A getter is
 // never treated as market data. Arbitrary Proxy/internal mutation is unsupported.
 guard();const calculated=new Map();
 for(const item of pending){if(item.sourceIndex===undefined)continue;let array=item.array;
  if(item.entry){const id=item.row.indicator;let outputs=calculated.get(id);if(!outputs){let data;try{data=IndicatorEngine.prototype.get.call(engine,id);guard();}catch(error){explorerInvalidateCalculation(model,engine,entries,id,item.entry,source,columnOwner);throw error;}outputs=explorerSlot(data,'outputs',true);calculated.set(id,outputs);}array=explorerVector(explorerSlot(outputs,item.key,true),length);}
  const value=array[item.sourceIndex];item.row.value=Number.isFinite(value)?value:null;item.row.sourceIndex=item.sourceIndex;item.row.sourceTime=vectors[0][item.sourceIndex];item.row.status=Number.isFinite(value)?'value':'non-finite';
 }
 const result={index,time:bar.time,asOfIndex:cutoff,storeVersion:version,primary:{symbol:primarySymbol,bar},series:pending.map(item=>item.row)};
 guard();return result;
}

const COMPACTION_MAX_PEAK=192*RESOURCE_LIMITS.maxBars, compactionMapEntries=Map.prototype.entries;
const compactionTyped=Object.getPrototypeOf(Float64Array.prototype),compactionTypedLength=Object.getOwnPropertyDescriptor(compactionTyped,'length').get,compactionTypedBuffer=Object.getOwnPropertyDescriptor(compactionTyped,'buffer').get,compactionBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
function compactionStale(){const e=new Error('Compaction owner or source changed');e.name='StaleSourceError';throw e;}
function compactionRecord(value,keys,label){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError(label+' plain data compactionRecord');const result={};for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!keys.includes(key)||!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError(label+' own data properties');result[key]=d.value;}return result;}
// Internal public objects must retain their ordinary own-data shape. Accessors,
// substituted maps and arbitrary proxies are not supported compaction owners.
function compactionCapture(object,keys,guards,writes=[]){const result={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(object,key);if(d&&!Object.hasOwn(d,'value')||writes.includes(key)&&(d?!d.writable:!Object.isExtensible(object)))throw new TypeError('Compaction owner own writable data required');result[key]=d?.value;guards.push(()=>{const next=Object.getOwnPropertyDescriptor(object,key);if(Boolean(next)!==Boolean(d)||next&&(!Object.hasOwn(next,'value')||!Object.is(next.value,d.value)||next.writable!==d.writable||next.configurable!==d.configurable))compactionStale();});}return result;}
function compactionRows(array,guards){if(!Array.isArray(array)||Object.getPrototypeOf(array)!==Array.prototype)throw new TypeError('Compaction ordinary array required');const length=Object.getOwnPropertyDescriptor(array,'length').value,copy=[];guards.push(()=>{if(Object.getOwnPropertyDescriptor(array,'length').value!==length)compactionStale();});for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(array,String(i));if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Compaction dense own data array');copy.push(d.value);guards.push(()=>{if(Object.getOwnPropertyDescriptor(array,String(i))?.value!==d.value)compactionStale();});}return copy;}
// Queue preservation validates positional meaning, not future drain budgets or
// intermediate volume arithmetic. Never call the overridable prefix()/stats().
function compactionPending(ingestion,source,refs,removed,guards){
 const q=compactionCapture(ingestion,['sourceVersion','head','count','capacity','columns','kinds','nextSequence','firstPendingSequence','policy','counters','lastError'],guards);
 if(q.sourceVersion!==source.version)throw new Error('Compaction pending source version changed');
 if(!Number.isSafeInteger(q.capacity)||q.capacity<1||q.capacity>4096||!Number.isSafeInteger(q.count)||q.count<0||q.count>q.capacity||!Number.isSafeInteger(q.head)||q.head<0||q.head>=q.capacity)throw new TypeError('Compaction pending ring bounds');
 const policyKeys=['streamId','generation','firstSequence','maxQueuedEvents','maxQueuedBytes','maxBatchEvents','maxStoredBars','maxStoreBytes'],counterKeys=['accepted','applied','cancelled','rejectedPackets','rejectedEvents','failedDrains','peakPendingEvents','peakPendingBytes','lastAppliedSequence','lastCancelledSequence'];
 compactionRecord(q.policy,policyKeys,'Compaction ingestion policy');compactionCapture(q.policy,policyKeys,guards);
 compactionRecord(q.counters,counterKeys,'Compaction ingestion counters');compactionCapture(q.counters,counterKeys,guards);
 const columns=compactionCapture(q.columns,FIELDS,guards);
 for(const key of FIELDS){const a=columns[key];if(!(a instanceof Float64Array)||compactionTypedLength.call(a)!==q.capacity)throw new TypeError('Compaction pending Float64 columns');compactionBufferLength.call(compactionTypedBuffer.call(a));}
 if(!(q.kinds instanceof Uint8Array)||compactionTypedLength.call(q.kinds)!==q.capacity)throw new TypeError('Compaction pending kind column');compactionBufferLength.call(compactionTypedBuffer.call(q.kinds));
 // At most 4096 * 49 extra typed bytes, independent of store capacity. This
 // owned FIFO copy also checks that later owner inspection did not alter it.
 const snapshot=Object.fromEntries(FIELDS.map(key=>[key,new Float64Array(q.count)])),kinds=new Uint8Array(q.count),appended=new Set(),bar={};let tail=refs.time[source.length-1];
 for(let i=0;i<q.count;i++){
  const at=(q.head+i)%q.capacity;for(const key of FIELDS)bar[key]=snapshot[key][i]=columns[key][at];const kind=kinds[i]=q.kinds[at];validateBar(bar);
  if(kind===0){if(!(bar.time>tail))throw new Error('Compaction pending append must follow virtual tail');tail=bar.time;appended.add(bar.time);}
  else if(kind===1){if(bar.time!==tail)throw new Error('Compaction pending update must match virtual tail');}
  else if(kind===2){let low=removed,high=source.length;while(low<high){const mid=low+Math.floor((high-low)/2);if(refs.time[mid]<bar.time)low=mid+1;else high=mid;}if(!appended.has(bar.time)&&(low===source.length||refs.time[low]!==bar.time))throw new Error('Compaction pending correction requires retained timestamp');}
  else throw new TypeError('Compaction pending event kind');
 }
 guards.push(()=>{for(let i=0;i<q.count;i++){const at=(q.head+i)%q.capacity;if(q.kinds[at]!==kinds[i])compactionStale();for(const key of FIELDS)if(!Object.is(columns[key][at],snapshot[key][i]))compactionStale();}});
}
function compactData(api,options){
 const guards=[],a=compactionCapture(api,['model','controller'],guards),model=a.model;
 if(!model)throw new Error('Chart disposed');
 const m=compactionCapture(model,['store','indicators','series','panels','axes','drawings','view','follow','crosshair','dataIngestion','disposed'],guards,['view','crosshair']);
 if(m.disposed)throw new Error('Chart disposed');
 const store=m.store,s=compactionCapture(store,['columns','index','length','capacity','maxBars','version','timeVersion'],guards,['columns','index','length','capacity','version','timeVersion']);
 const refs=compactionCapture(s.columns,FIELDS,guards);
 if(!(store instanceof BarStore))throw new TypeError('Compaction BarStore required');
 const o=compactionRecord(options,['keepLastBars','studyHistory','maxPeakStoreBytes','pendingData'],'Compaction options'),keep=o.keepLastBars,limit=o.maxPeakStoreBytes??COMPACTION_MAX_PEAK;
 if(!Number.isSafeInteger(keep)||keep<1||keep>RESOURCE_LIMITS.maxBars||o.studyHistory!=='restart')throw new RangeError('Positive keepLastBars and studyHistory restart required');
 if(o.pendingData!==undefined&&o.pendingData!=='preserve-retained'&&o.pendingData!=='reject')throw new TypeError('Compaction pendingData policy');
 if(!Number.isSafeInteger(limit)||limit<0||limit>COMPACTION_MAX_PEAK)throw new RangeError('Compaction source peak byte limit');
 if(!s.length)throw new RangeError('Cannot compact an empty store');
 for(const key of FIELDS){const source=refs[key];if(!(source instanceof Float64Array)||compactionTypedLength.call(source)!==s.capacity)throw new TypeError('Compaction owned Float64 columns');compactionBufferLength.call(compactionTypedBuffer.call(source));}
 const current=()=>{for(const check of guards)check();};current();
 const receipt={removed:0,length:s.length,capacity:s.capacity,bytes:96*s.capacity,previousBytes:96*s.capacity,peakSourceBytes:96*s.capacity,firstRetainedTime:refs.time[0],version:s.version,timeVersion:s.timeVersion,studyHistory:'restart',invalidationFailed:false};
 if(keep>=s.length)return receipt;
 const engine=m.indicators,e=compactionCapture(engine,['store','entries'],guards);if(e.store!==store||!exclusiveStoreOwners(store,model,engine))throw new Error('Compaction requires one exclusive live model and indicator engine');
 const ownerCheck=()=>{current();if(!exclusiveStoreOwners(store,model,engine))compactionStale();assertDataIngestionIdle(model);};
 assertDataIngestionIdle(model);
 const drawing=compactionCapture(m.drawings,['transaction'],guards);if(drawing.transaction)throw new Error('Compaction during drawing transaction');
 if(a.controller){const control=compactionCapture(a.controller,['model','gesture'],guards);if(control.model!==model||control.gesture)throw new Error('Compaction during interaction gesture');}
 const series=compactionRows(m.series,guards).map(row=>({row,state:compactionCapture(row,['values','offset','visible','rangeIndex','revision','dirtyFrom'],guards,['rangeIndex','revision','dirtyFrom'])}));
 if(series.some(({state})=>state.values!==undefined&&state.values!==null))throw new Error('Compaction requires host realignment of external values');
 for(const p of compactionRows(m.panels,guards)){const state=compactionCapture(p,['scale','base'],guards);if(state.scale==='percent'&&state.base===undefined)throw new Error('Compaction percent panel requires an explicit base');}
 compactionRows(m.axes,guards);
 const view=compactionCapture(m.view,['from','to'],guards);if(!Number.isFinite(view.from)||!Number.isFinite(view.to)||view.to<=view.from)throw new TypeError('Compaction visible range');
 let ingestion;
 if(m.dataIngestion){ingestion=compactionCapture(m.dataIngestion,['model','store','sourceVersion','policy','paused','count','draining','leased','closed','epoch'],guards,['sourceVersion','epoch']);if(ingestion.model!==model||ingestion.store!==store||ingestion.closed||!ingestion.paused||(ingestion.count&&o.pendingData!=='preserve-retained')||ingestion.draining||ingestion.leased)throw new Error('Compaction requires paused empty idle ingestion unless preserving retained pending data');if(o.pendingData==='preserve-retained')compactionPending(m.dataIngestion,s,refs,s.length-keep,guards);}
 if(![Map.prototype,NativeCheckpointEntries.prototype].includes(Object.getPrototypeOf(e.entries))||Reflect.ownKeys(e.entries).length)throw new TypeError('Compaction ordinary owned indicator entries');
 const entries=[...compactionMapEntries.call(e.entries)],entrySize=Object.getOwnPropertyDescriptor(Map.prototype,'size').get;
 guards.push(()=>{if(entrySize.call(e.entries)!==entries.length)compactionStale();for(const [id,row] of entries)if(Map.prototype.get.call(e.entries,id)!==row)compactionStale();});
 const plans=entries.map(([,row])=>{if(Object.getPrototypeOf(row)!==Object.prototype)throw new TypeError('Compaction plain indicator entry');const state=compactionCapture(row,['checkpoints','arrays','dirty','dirtyTo','invalidated','length','computedFrom','computedUntil','preparedVersion'],guards,['arrays','dirty','dirtyTo','invalidated','length','computedFrom','computedUntil','preparedVersion']);return {row,clear:ownedCheckpointClear(state.checkpoints),arrays:[]};});
 let capacity=16;while(capacity<keep)capacity*=2;const peak=96*(s.capacity+capacity);if(peak>limit)throw new RangeError('Compaction source peak byte budget');
 const removed=s.length-keep,columns={};
 for(const key of FIELDS){const source=refs[key];columns[key]=new Float64Array(capacity);for(let i=0;i<keep;i++)columns[key][i]=source[removed+i];}
 const bar={};let previous=-Infinity;for(let i=0;i<keep;i++){for(const key of FIELDS)bar[key]=columns[key][i];validateBar(bar,previous);previous=bar.time;}
 const index=new RangeIndex(keep,columns.low,columns.high,columns.volume,capacity),span=view.to-view.from,forward=Math.max(0,...series.filter(({state})=>state.visible!==false).map(({state})=>state.offset??0));
 const end=keep+forward-.5,from=m.follow?end-span:Math.max(-.5,Math.min(end-span,view.from-removed)),nextView={from,to:from+span};
 Object.assign(receipt,{removed,length:keep,capacity,bytes:96*capacity,peakSourceBytes:peak,firstRetainedTime:columns.time[0],version:s.version+1,timeVersion:s.timeVersion+1});
 ownerCheck();
 // No user callback from here until the complete source/cache/view/ledger state
 // has been installed. Native clear returns private ledger bytes without decode.
 for(const plan of plans){plan.clear();Object.assign(plan.row,{arrays:plan.arrays,dirty:0,dirtyTo:keep,invalidated:true,length:0,computedFrom:0,computedUntil:0,preparedVersion:undefined});}
 for(const {row} of series){row.rangeIndex=null;row.revision=undefined;row.dirtyFrom=0;}
 store.columns=columns;store.index=index;store.length=keep;store.capacity=capacity;model.view=nextView;model.crosshair=null;
 if(ingestion){m.dataIngestion.sourceVersion=receipt.version;m.dataIngestion.epoch=ingestion.epoch+1;}
 BarStore.prototype.changed.call(store,0,'compact',{removed,studyHistory:'restart'});
 // Store listeners have their existing bounded error channel. New API keeps a
 // successful committed receipt even if the host invalidation observer throws.
 try{api.invalidate();}catch{receipt.invalidationFailed=true;}
 return receipt;
}


const translationStringify=JSON.stringify,translationDefine=Object.defineProperty;
function translationSlot(object,key,required=false){const d=Object.getOwnPropertyDescriptor(object,key);if(!d){if(required)throw new TypeError('Drawing group edit missing '+key);return undefined;}if(!Object.hasOwn(d,'value'))throw new TypeError('Drawing group edit own data properties required');return d.value;}
function translationRecord(value,keys){if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Drawing group edit plain record required');const out=Object.create(null);for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||!keys.includes(key))throw new TypeError('Drawing group edit fields');const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Drawing group edit own data fields required');out[key]=d.value;}return out;}
function translationList(value,max){if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError('Drawing group edit plain array required');const n=translationSlot(value,'length',true);if(n>max||Reflect.ownKeys(value).length!==n+1)throw new RangeError('Drawing group edit array limit/shape');const result=[];for(let i=0;i<n;i++)result.push(translationSlot(value,String(i),true));return result;}
function translationStale(){throw new Error('Drawing group edit owner changed');}
function translationCapture(object,keys,guards,writes=[]){if(!object||typeof object!=='object')throw new TypeError('Drawing group edit managed owner required');const state=Object.create(null);for(const key of keys){state[key]=translationSlot(object,key);if(writes.includes(key)){const d=Object.getOwnPropertyDescriptor(object,key);if(!d?.writable)throw new TypeError('Drawing group edit writable own state required');}}guards.push(()=>{for(const key of keys)if(!Object.is(translationSlot(object,key),state[key]))translationStale();});return state;}
function translationCapturedList(value,max,guards){const copy=translationList(value,max);guards.push(()=>{if(translationSlot(value,'length')!==copy.length)translationStale();for(let i=0;i<copy.length;i++)if(translationSlot(value,String(i))!==copy[i])translationStale();});return copy;}
function translationDrawing(value){
 if(!Object.isFrozen(value))throw new TypeError('Drawing group edit requires immutable managed drawings');
 const d=translationRecord(value,['id','type','panel','points','style','text','locked','axisId','seriesId']);
 if(!Object.isFrozen(d.points))throw new TypeError('Drawing group edit immutable anchors required');
 d.points=translationList(d.points,2048).map(point=>{if(!Object.isFrozen(point))throw new TypeError('Drawing group edit immutable anchor required');return translationRecord(point,['time','price']);});
 if(d.style!==undefined){if(!Object.isFrozen(d.style))throw new TypeError('Drawing group edit immutable style required');d.style=translationRecord(d.style,['color','fill','width','font']);}
 validateDrawing(d);return d;
}
// JSON character count without invoking toJSON or caller array/object methods.
function translationChars(value){if(value===null)return 4;if(typeof value!=='object')return translationStringify(value).length;if(Array.isArray(value)){let n=2;for(let i=0;i<value.length;i++)n+=(i?1:0)+translationChars(value[i]);return n;}let n=2,count=0;for(const key of Object.keys(value)){if(value[key]===undefined)continue;n+=(count++?1:0)+translationStringify(key).length+1+translationChars(value[key]);}return n;}
function translationFrozen(d){for(const p of d.points)Object.freeze(p);Object.freeze(d.points);if(d.style)Object.freeze(d.style);return Object.freeze(d);}

/** Explicit raw-coordinate group edit. No indicator/layout computation. */
function translateDrawings(api,ids,options){return drawingGroupEdit(api,ids,options,false);}
/** Mixed and orphan bindings may be removed without querying live metadata. */
function deleteDrawings(api,ids){return drawingGroupEdit(api,ids,null,true);}
function drawingGroupEdit(api,ids,options,remove){
 const guards=[],a=translationCapture(api,['model','controller','invalidate'],guards),model=a.model;
 const m=translationCapture(model,remove?['disposed','drawings']:['disposed','drawings','panels','axes','series'],guards);
 if(m.disposed)throw new Error('Chart disposed');if(!(m.drawings instanceof DrawingStore))throw new TypeError('Drawing group edit managed store required');
 const d=m.drawings,s=translationCapture(d,['items','undoStack','redoStack','selected','serial','transaction','maxDrawings','maxPoints','maxDocumentChars','historyLimit','historyBytes','retainedHistoryBytes'],guards,['items','undoStack','redoStack']);
 const retained=Object.getOwnPropertyDescriptor(d,'retainedHistoryBytes');if(retained&&!retained.writable||!retained&&!Object.isExtensible(d))throw new TypeError('Drawing group edit writable history accounting required');
 const c=a.controller?translationCapture(a.controller,['model','gesture'],guards):null;
 if(c&&c.model!==model)throw new Error('Drawing group edit controller owner mismatch');if(s.transaction||c?.gesture)throw new Error('Drawing group edit requires no active gesture or transaction');
 const items=translationCapturedList(s.items,RESOURCE_LIMITS.maxDrawings,guards),undo=translationCapturedList(s.undoStack,10000,guards),redo=translationCapturedList(s.redoStack,10000,guards);
 const panels=remove?null:translationCapturedList(m.panels,RESOURCE_LIMITS.maxPanels,guards).map(p=>translationCapture(p,['id'],guards));
 const axes=remove?null:translationCapturedList(m.axes,RESOURCE_LIMITS.maxAxes,guards).map(p=>translationCapture(p,['id','panel'],guards));
 const series=remove?null:translationCapturedList(m.series,RESOURCE_LIMITS.maxSeries,guards).map(p=>translationCapture(p,['id','panel','axisId'],guards));
 const keys=translationList(ids,128),o=remove?null:translationRecord(options,['deltaTimeMs','deltaPrice']);
 if(!keys.length)throw new RangeError('Drawing group edit requires 1..128 ids');
 const selected=new Set();for(const id of keys){identifier(id,'Drawing id');if(selected.has(id))throw new TypeError('Duplicate drawing id');selected.add(id);}
 if(!remove&&(!Number.isFinite(o.deltaTimeMs)||!Number.isFinite(o.deltaPrice)))throw new TypeError('Finite deltaTimeMs and deltaPrice required');
 for(const [key,max,min] of [['maxDrawings',10000,0],['maxPoints',2097152,0],['maxDocumentChars',RESOURCE_LIMITS.maxDocumentChars,0],['historyLimit',10000,1],['historyBytes',RESOURCE_LIMITS.maxHistoryBytes,0]])if(!Number.isSafeInteger(s[key])||s[key]<min||s[key]>max)throw new RangeError('Drawing group edit history/resource limit');
 const copies=new Map(),weights=new Map(),copy=value=>{let result=copies.get(value);if(!result){result=translationDrawing(value);copies.set(value,result);weights.set(value,2*translationChars(result));}return result;};
 let next=items.slice();const seen=new Set(),clearSelected=remove&&selected.has(s.selected);
 if(clearSelected){const writable=()=>{const descriptor=Object.getOwnPropertyDescriptor(d,'selected');if(!descriptor||!Object.hasOwn(descriptor,'value')||!descriptor.writable)throw new TypeError('Drawing group edit writable selection required');};writable();guards.push(writable);}
 let binding=null,changed=0,points=0,text=0;
 for(let i=0;i<items.length;i++){
  const rawPoints=translationSlot(items[i],'points',true);if(!Array.isArray(rawPoints))throw new TypeError('Drawing anchors');points+=translationSlot(rawPoints,'length',true);if(points>s.maxPoints)throw new RangeError('Drawing group edit point limit');
  const before=copy(items[i]);if(seen.has(before.id))throw new TypeError('Duplicate drawing id');seen.add(before.id);text+=before.text?.length??0;
  if(!selected.has(before.id))continue;
  if(before.locked)throw new Error('Drawing is locked');
  if(remove){next[i]=null;changed++;continue;}
  const b=[before.panel,before.axisId??null,before.seriesId??null];if(binding&&b.some((v,j)=>v!==binding[j]))throw new Error('Drawing group edit requires identical panel/axis/series binding');binding=b;
  if(!panels.some(p=>p.id===b[0])||b[1]!==null&&!axes.some(p=>p.id===b[1]&&p.panel===b[0])||b[2]!==null&&!series.some(p=>p.id===b[2]&&p.panel===b[0]&&(p.axisId??null)===b[1]))throw new Error('Missing or mismatched drawing binding');
  let moved=false;const anchors=before.points.map(p=>{const time=o.deltaTimeMs===0?p.time:p.time+o.deltaTimeMs,price=o.deltaPrice===0?p.price:p.price+o.deltaPrice;if(time!==p.time||price!==p.price)moved=true;return {time,price};});
  const candidate={...before,points:anchors};if(before.style!==undefined)candidate.style=translationSlot(items[i],'style');validateDrawing(candidate);if(moved){next[i]=translationFrozen(candidate);changed++;}
 }
 if(keys.some(id=>!seen.has(id)))throw new Error('Missing drawing');if(items.length>s.maxDrawings||points>s.maxPoints||text>1000000)throw new RangeError('Drawing group edit resource limit');
 if(remove)next=next.filter(value=>value!==null);
 const receipt={changed,invalidationFailed:false};
 if(!changed){for(const check of guards)check();return receipt;}
 const snapshotWeight=snapshot=>{let n=snapshot.length*8;for(const value of snapshot){copy(value);n+=weights.get(value);}return n;};
 const priorWeight=snapshotWeight(items);if(priorWeight>s.historyBytes)throw new RangeError('Drawing group edit undo snapshot exceeds historyBytes');
 const history=[],historyWeights=[];let priorHistoryBytes=0;
 for(const snapshot of undo){const rows=translationCapturedList(snapshot,s.maxDrawings,guards),weight=snapshotWeight(rows);priorHistoryBytes+=weight;if(priorHistoryBytes>RESOURCE_LIMITS.maxHistoryBytes)throw new RangeError('Drawing group edit retained history resource limit');history.push(rows);historyWeights.push(weight);}
 history.push(items);historyWeights.push(priorWeight);
 let retainedBytes=historyWeights.reduce((x,y)=>x+y,0),start=0;while(history.length-start>s.historyLimit||retainedBytes>s.historyBytes)retainedBytes-=historyWeights[start++];
 const nextUndo=history.slice(start),nextRedo=[];
 // All validation/history sizing is complete before publication. No overridable
 // begin/commit/trim/weight method or serializer is called after this guard.
 for(const check of guards)check();
 translationDefine(d,'items',{value:next});translationDefine(d,'undoStack',{value:nextUndo});translationDefine(d,'redoStack',{value:nextRedo});translationDefine(d,'retainedHistoryBytes',retained?{value:retainedBytes}:{value:retainedBytes,writable:true,enumerable:true,configurable:true});
 if(clearSelected)translationDefine(d,'selected',{value:null});
 try{a.invalidate.call(api);}catch{receipt.invalidationFailed=true;}
 return receipt;
}


const PRESENTATION_KEYS=new Set(['color','fill','upColor','downColor','width','visible','label']);
function style(options,colors=['color','fill','upColor','downColor']) {return portableStyle(options,colors);}
function values(input) {
 if (!(input instanceof Float64Array)&&!Array.isArray(input)) throw new TypeError('Values must be Float64Array or a JSON array');
 for(const x of input) if(x!==null&&typeof x!=='number'||Number.isNaN(x)&&!(input instanceof Float64Array)||x===Infinity||x===-Infinity) throw new TypeError('Finite numbers or null gaps required');
 return Float64Array.from(input,x=>x===null?NaN:x);
}
function columns(input) {return Object.fromEntries(FIELDS.map(key=>[key,values(input?.[key])]));}
const COMMANDS=new Set(['compactData','setData','setColumns','applyDataEvent','applyDataEvents','configureDataIngestion','enqueueDataEvents','drainDataEvents','pauseDataIngestion','resumeDataIngestion','cancelDataEvents','dataIngestionStats','saveDataIngestion','loadDataIngestion','addPanel','setPanel','addAxis','setAxis','removeAxis','setDrawingTarget','crosshairValues','dataAt','addSeries','setSeries','setSeriesValues','removeSeries','addIndicator','setIndicatorParams','removeIndicator','indicatorValues','indicatorValueAt','registerIndicatorModule','saveStudies','loadStudies','addDrawing','editDrawing','translateDrawings','deleteDrawings','deleteDrawing','selectDrawing','saveDrawings','loadDrawings','undo','redo','setTool','setText','setTheme','setSymbol','setVisibleRange','fit','zoom','pan','inspect']);

/** Shared web/JavaScriptCore/QuickJS facade. JSON arguments retain Double values.
 * Factories passed as source are trusted application code, never market data.
 */
class ChartAPI {
 constructor(model,{controller=null,invalidate=()=>{}}={}) {this.model=model;this.controller=controller;this.invalidate=invalidate;}
 dispatch(operation,args=[]) {
  if(!COMMANDS.has(operation)||!Array.isArray(args))throw new TypeError('Unknown chart command or argument list');
  const arity={compactData:1,setData:1,setColumns:2,applyDataEvent:1,applyDataEvents:1,configureDataIngestion:1,enqueueDataEvents:1,drainDataEvents:1,pauseDataIngestion:0,resumeDataIngestion:0,cancelDataEvents:0,dataIngestionStats:0,saveDataIngestion:0,loadDataIngestion:1,addPanel:1,setPanel:2,addAxis:1,setAxis:2,removeAxis:1,setDrawingTarget:1,crosshairValues:2,dataAt:2,addSeries:1,setSeries:2,setSeriesValues:2,removeSeries:1,addIndicator:3,setIndicatorParams:2,removeIndicator:1,indicatorValues:2,indicatorValueAt:4,registerIndicatorModule:2,saveStudies:0,loadStudies:1,addDrawing:1,editDrawing:2,translateDrawings:2,deleteDrawings:1,deleteDrawing:1,selectDrawing:1,saveDrawings:0,loadDrawings:1,undo:0,redo:0,setTool:1,setText:1,setTheme:1,setSymbol:1,setVisibleRange:2,fit:0,zoom:2,pan:1,inspect:0};if(args.length>arity[operation])throw new TypeError('Chart command argument count');
  return this[operation](...args)??null;
 }
 changed(result) {this.invalidate();return result;}
 compactData(options){return compactData(this,options);}
 setData(bars) {this.model.store.setData(bars);return this.changed();}
 setColumns(data,length) {this.model.store.setColumns(columns(data),length);return this.changed();}
 applyDataEvent(event) {if(event?.kind==='batch')return this.applyDataEvents(event.events);const next=event?.kind==='reset'&&event.columns?{...event,columns:columns(event.columns)}:event;applyDataEvent(this.model.store,next);return this.changed();}
 applyDataEvents(events){const model=this.model;if(model.disposed)throw new Error('Chart disposed');const store=model.store,version=store.version,series=model.series,ingestion=model.dataIngestion,epoch=ingestion?.epoch,bindings=series.map(s=>[s,s.values]),snapshot=snapshotIngestionEvents(events);if(model.disposed||model.store!==store||store.version!==version||model.dataIngestion!==ingestion||ingestion?.epoch!==epoch||model.series!==series||series.length!==bindings.length||bindings.some(([s,v],i)=>series[i]!==s||s.values!==v))throw new IngestionError('SOURCE_CHANGED','Owner changed during batch snapshot');if(snapshot.some(e=>e.kind==='append')&&series.some(s=>s.values))throw new IngestionError('EXTERNAL_ALIGNMENT','Length-changing batches require host realignment of external values');return this.changed(store.applyEvents(snapshot,ingestion?{maxBars:ingestion.policy.maxStoredBars,maxStoreBytes:ingestion.policy.maxStoreBytes}:{}));}
 ingestion(){if(this.model.disposed)throw new Error('Chart disposed');if(!this.model.dataIngestion)throw new IngestionError('NOT_CONFIGURED','Configure data ingestion first');return this.model.dataIngestion;}
 configureDataIngestion(options){if(this.model.disposed)throw new Error('Chart disposed');assertDataIngestionIdle(this.model);const old=this.model.dataIngestion;old?.idle();if(old?.count)throw new IngestionError('PENDING_DATA','Drain or cancel pending data before reconfiguration');const candidate=new DataIngestion(this.model,options);try{assertDataIngestionIdle(this.model);old?.idle();if(this.model.dataIngestion!==old||old?.count)throw new IngestionError('SOURCE_CHANGED','Ingestion owner changed during configuration');this.model.dataIngestion=candidate;old?.dispose();return candidate.stats();}catch(error){candidate.dispose();throw error;}}
 enqueueDataEvents(packet){return this.ingestion().enqueue(packet);}
 drainDataEvents(maxEvents){const receipt=this.ingestion().drain(maxEvents);if(receipt.events)this.invalidate();return receipt;}
 pauseDataIngestion(){return this.ingestion().pause();}
 resumeDataIngestion(){return this.ingestion().resume();}
 cancelDataEvents(){return this.ingestion().cancel();}
 dataIngestionStats(){return this.ingestion().stats();}
 saveDataIngestion(){return this.ingestion().save();}
 loadDataIngestion(text){if(this.model.disposed)throw new Error('Chart disposed');assertDataIngestionIdle(this.model);const old=this.model.dataIngestion;old?.idle();if(old?.count)throw new IngestionError('PENDING_DATA','Cancel or drain pending data before restoration');let candidate;try{candidate=restoreDataIngestion(this.model,text);assertDataIngestionIdle(this.model);old?.idle();if(this.model.dataIngestion!==old||old?.count)throw new IngestionError('SOURCE_CHANGED','Ingestion owner changed during restoration');this.model.dataIngestion=candidate;old?.dispose();return candidate.stats();}catch(error){candidate?.dispose();throw error instanceof IngestionError?error:new IngestionError('INVALID_DOCUMENT',String(error.message).slice(0,256),error);}}
 addPanel(options) {return this.changed(this.model.addPanel(options));}
 setPanel(id,patch) {if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new TypeError('Panel patch object');const next={...patch};if(next.range===null)next.range=undefined;if(next.base===null)next.base=undefined;this.model.setPanel(id,next);return this.changed();}
 addAxis(options){return this.changed(this.model.addAxis(options));}
 setAxis(id,patch){optionRecord(patch,AXIS_KEYS.filter(k=>k!=='id'&&k!=='panel'),'Axis patch');const next={...patch};if(next.range===null)next.range=undefined;if(next.base===null)next.base=undefined;this.model.setAxis(id,next);return this.changed();}
 removeAxis(id){this.model.removeAxis(id);if(this.controller?.drawingTarget?.axisId===id)this.controller.setDrawingTarget(null,{notify:false});return this.changed();}
 setDrawingTarget(target){if(!this.controller)throw new Error('Interaction controller required');this.controller.setDrawingTarget(target,{notify:false});return this.changed();}
 dataAt(query,options={}){const d=Object.getOwnPropertyDescriptor(this,'model');if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Data query own model required');const model=d.value,result=dataAt(model,query,options),current=Object.getOwnPropertyDescriptor(this,'model');if(!current||!Object.hasOwn(current,'value')||current.value!==model){const error=new Error('Data query API owner changed');error.name='StaleSourceError';throw error;}return result;}
 crosshairValues(width,height){return crosshairValuesAt(this.model,createLayout(this.model,width,height));}
 seriesOptions(options) {
  optionRecord(options,SERIES_KEYS,'Series');const next=style(options);
  if(next.values!==undefined&&next.values!==null)next.values=values(next.values);
  if(next.source!==undefined&&!FIELDS.includes(next.source))throw new TypeError('Unknown column source');
  if(next.width!==undefined&&(!Number.isFinite(next.width)||next.width<=0||next.width>50))throw new RangeError('Series width');
  if(next.baseline!==undefined&&!Number.isFinite(next.baseline))throw new RangeError('Series baseline');
  if(next.visible!==undefined&&typeof next.visible!=='boolean')throw new TypeError('Series visible');
  if(next.indicator){const data=this.model.indicators.get(next.indicator);if(next.output!==undefined&&next.output!==null&&!Object.hasOwn(data.outputs,next.output))throw new Error('Missing indicator output');}
  if(['candles','ohlc'].includes(next.type)&&(next.indicator||next.values||next.source!==undefined))throw new TypeError('Candles/OHLC read store OHLCV; custom source/values/indicator need a general series');
  return next;
 }
 addSeries(options) {return this.changed(this.model.addSeries(this.seriesOptions(options)));}
 setSeries(id,patch) {
  const index=this.model.series.findIndex(s=>s.id===id);if(index<0)throw new Error('Missing series');
  const current=this.model.series[index];
  if(patch&&typeof patch==='object'&&Reflect.ownKeys(patch).every(key=>PRESENTATION_KEYS.has(key))){
   const model=this.model,series=model.series,store=model.store,version=store.version,engine=model.indicators,entries=engine.entries,indicator=current.indicator,entry=indicator?Map.prototype.get.call(entries,indicator):null,valuesRevision=model.seriesValuesRevision;
   const own=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
   const guard=()=>{if(own(model,'disposed'))throw new Error('Chart disposed');if(own(this,'model')!==model||own(model,'series')!==series||series[index]!==current||own(model,'store')!==store||own(store,'version')!==version||own(model,'seriesValuesRevision')!==valuesRevision||own(model,'indicators')!==engine||own(engine,'entries')!==entries||indicator&&Map.prototype.get.call(entries,indicator)!==entry){const error=new Error('Series presentation owner changed');error.name='StaleSourceError';throw error;}};
   const presentation=this.seriesOptions(patch);if(presentation.label!==undefined)boundedText(presentation.label,256,'Series label');guard();
   if(indicator&&!entry)throw new Error(`Missing indicator: ${indicator}`);
   // The binding was already validated. Preserve its caches; only presentation changes.
   const next={...current,...presentation};for(const key of Object.keys(next))if(!SERIES_KEYS.includes(key)&&!['rangeIndex','revision','dirtyFrom'].includes(key))delete next[key];guard();
   series[index]=next;return this.changed();
  }
  const next={...current,...this.seriesOptions(patch)};
  if(next.indicator){const data=this.model.indicators.get(next.indicator);if(next.output!==undefined&&next.output!==null&&!Object.hasOwn(data.outputs,next.output))throw new Error('Missing indicator output');}
  if(['candles','ohlc'].includes(next.type)&&(next.indicator||next.values||next.source!==undefined))throw new TypeError('Candles/OHLC read store OHLCV; custom source/values/indicator need a general series');
  // Reuse core validation before replacing; retain painter order and discard
  // stale range caches. A rejected patch leaves the original series untouched.
  if(Object.hasOwn(patch,'indicator')||Object.hasOwn(patch,'output'))next.offset=patch.offset;
  if(next.indicator===null)delete next.indicator;if(next.output===null)delete next.output;if(next.values===null)delete next.values;
  const sameData=current.values===next.values&&current.indicator===next.indicator&&current.output===next.output&&(current.source??'close')===(next.source??'close');
  for(const key of Object.keys(next))if(!SERIES_KEYS.includes(key))delete next[key];
  const validated=this.model.normalizedSeries({...next,id});
  if((current.axisId??null)!==(validated.axisId??null)||current.panel!==validated.panel){const active=this.model.drawings.items.find(d=>d.id===this.controller?.gesture?.id);if(active?.seriesId===id)this.controller.cancel({notify:false});}
  this.model.series[index]={...validated,id,...(sameData?{rangeIndex:current.rangeIndex,revision:current.revision,dirtyFrom:current.dirtyFrom}:{})};const target=this.controller?.drawingTarget;if(target?.seriesId===id&&(target.panel!==validated.panel||(target.axisId??null)!==(validated.axisId??null)))this.controller.setDrawingTarget({...target,panel:validated.panel,axisId:validated.axisId??null},{notify:false});return this.changed();
 }
 setSeriesValues(id,input) {this.model.setSeriesValues(id,values(input));return this.changed();}
 removeSeries(id) {const active=this.model.drawings.items.find(d=>d.id===this.controller?.gesture?.id);if(active?.seriesId===id)this.controller.cancel({notify:false});if(this.controller?.drawingTarget?.seriesId===id)this.controller.setDrawingTarget(null,{notify:false});this.model.removeSeries(id);return this.changed();}
 addIndicator(id,name,params={}) {const data=this.model.indicators.add(id,name,params);return this.changed({outputs:Object.keys(data.outputs),plotOffsets:{...data.plotOffsets}});}
 setIndicatorParams(id,params){return this.changed(setStudyParams(this.model,id,params));}
 removeIndicator(id) {
  // Deletion needs entry ownership, never a calculation of data being discarded.
  const model=this.model,engine=model.indicators,entries=engine.entries,entry=entries.get(id);
  if(!entry)throw new Error(`Missing indicator: ${id}`);
  const own=(object,key)=>Object.getOwnPropertyDescriptor(object,key)?.value;
  const guard=()=>{
   if(own(model,'disposed'))throw new Error('Chart disposed');
   if(own(this,'model')!==model||own(model,'indicators')!==engine||own(engine,'entries')!==entries||Map.prototype.get.call(entries,id)!==entry){const error=new Error('Indicator removal owner changed');error.name='StaleSourceError';throw error;}
  };
  guard();
  const controller=this.controller,removed=model.series.filter(s=>s.indicator===id).map(s=>s.id),active=model.drawings.items.find(d=>d.id===controller?.gesture?.id);
  const cancel=removed.includes(active?.seriesId);guard();
  if(cancel){const cancelGesture=controller.cancel;guard();cancelGesture.call(controller,{notify:false});guard();}
  const clearTarget=removed.includes(controller?.drawingTarget?.seriesId);guard();
  if(clearTarget){const setTarget=controller.setDrawingTarget;guard();setTarget.call(controller,null,{notify:false});guard();}
  const remove=engine.remove;guard();
  const series=model.series.filter(s=>s.indicator!==id);guard();
  model.series=series;
  // Keep the engine's retirement path: native entries release their checkpoint ledger.
  remove.call(engine,id);return this.changed();
 }
 indicatorValues(id,output) {const data=this.model.indicators.get(id),key=output??Object.keys(data.outputs)[0];if(!Object.hasOwn(data.outputs,key))throw new Error('Missing indicator output');const array=data.outputs[key];return Array.from(array,v=>Number.isFinite(v)?v:null);}
 indicatorValueAt(id,output,index,options={}) {
  optionRecord(options,['mode','asOfIndex'],'Indicator query');const mode=options.mode??'raw',asOf=options.asOfIndex??this.model.store.length-1;
  if(!['raw','plot'].includes(mode)||!Number.isSafeInteger(index)||!Number.isSafeInteger(asOf)||asOf< -1||asOf>=this.model.store.length)throw new RangeError('Indicator query index/mode');
  const e=this.model.indicators.entries.get(id);if(!e)throw new Error('Missing indicator');requirePortableFactory(e.name,this.model.indicators.registry.get(e.name));
  const module=indicatorModule(e.name);if(module&&module.causal!==true)throw new TypeError('Unsupported noncausal study query');
  const data=this.model.indicators.get(id),key=output??Object.keys(data.outputs)[0];if(!Object.hasOwn(data.outputs,key))throw new Error('Missing indicator output');const array=data.outputs[key];
  const source=index-(mode==='plot'?(Object.hasOwn(data.plotOffsets,key)?data.plotOffsets[key]:0):0);
  if(source<0||source>=array.length||source>asOf)return {value:null,sourceIndex:null,sourceTime:null};
  return {value:Number.isFinite(array[source])?array[source]:null,sourceIndex:source,sourceTime:this.model.store.columns.time[source]};
 }
 registerIndicatorModule(id,version){const entries=indicatorModuleDefinitions(id,version);for(const e of entries){const current=this.model.indicators.registry.get(e.name);if(current&&current!==e.factory)throw new Error('Indicator module name conflict');}for(const e of entries)this.model.indicators.registry.set(e.name,e.factory);return this.changed(entries.map(e=>e.name));}
 saveStudies(){return saveStudySetup(this.model);}
 loadStudies(text){return this.changed(loadStudySetup(this.model,text));}
 registerIndicator(name,factory) {this.model.indicators.register(name,factory);return this.changed();}
 registerIndicatorSource(name,source) {
  if(typeof source!=='string'||source.length>65536)throw new TypeError('Trusted factory expression, at most 64KiB');
  const factory=Function('"use strict"; return ('+source+');')();if(typeof factory!=='function')throw new TypeError('Factory function required');
  return this.registerIndicator(name,factory);
 }
 drawingOptions(options) {optionRecord(options,['id','type','panel','points','style','text','locked','axisId','seriesId'],'Drawing');if(options.style)optionRecord(options.style,['color','fill','width','font'],'Drawing style');const next={...options,...(options.style?{style:style(options.style,['color','fill'])}:{})};if(next.seriesId!=null&&next.axisId===undefined){const s=this.model.series.find(s=>s.id===next.seriesId);if(s)next.axisId=s.axisId??null;}return next;}
 drawingMutationContext(){const d=this.model.drawings,interactive=!!this.controller?.gesture;return {items:interactive&&d.transaction?d.transaction:d.items,beforeMutation:interactive?()=>this.controller.cancel({notify:false}):null};}
 addDrawing(options) {const next={panel:'price',...this.drawingOptions(options)};this.model.validateDrawingBinding(next);return this.changed(this.model.drawings.add(next,this.drawingMutationContext()));}
 deleteDrawings(ids){return deleteDrawings(this,ids);}
 translateDrawings(ids,options){return translateDrawings(this,ids,options);}
 editDrawing(id,patch) {const context=this.drawingMutationContext(),previous=context.items.find(d=>d.id===id);if(!previous)throw new Error('Missing committed drawing');const next=this.drawingOptions(patch);this.model.validateDrawingBinding({...previous,...next});this.model.drawings.edit(id,next,context);return this.changed();}
 deleteDrawing(id=this.model.drawings.selected) {const context=this.drawingMutationContext();if(this.controller?.gesture?.kind==='create'&&this.controller.gesture.id===id&&!context.items.some(d=>d.id===id)){this.controller.cancel({notify:false});return this.changed(false);}return this.changed(this.model.drawings.remove(id,context));}
 selectDrawing(id) {if(id!==null&&!this.model.drawings.items.some(d=>d.id===id))throw new Error('Missing drawing');if(id!==this.model.drawings.selected)this.controller?.cancel({notify:false});this.model.drawings.selected=id;return this.changed();}
 saveDrawings() {return this.model.drawings.save();}
 loadDrawings(text) {this.model.drawings.load(text,{styleDecoder:options=>portableStyle(options,['color','fill'],true),validatePanel:id=>this.model.panels.some(p=>p.id===id),validateBinding:d=>this.model.validateDrawingBinding(d)});return this.changed();}
 undo() {if(this.controller)this.controller.key('z',{ctrl:true});else this.model.drawings.undo();return this.changed();}
 redo() {if(this.controller)this.controller.key('z',{ctrl:true,shift:true});else this.model.drawings.redo();return this.changed();}
 setTool(tool) {if(!this.controller)throw new Error('Interaction controller required');this.controller.setTool(tool,{notify:false});return this.changed();}
 setText(text) {if(!this.controller||typeof text!=='string'||text.length>2000)throw new TypeError('Drawing text, at most 2000 characters');this.controller.text=text;return this.changed();}
 setTheme(patch) {optionRecord(patch,THEME_KEYS,'Theme');const next=style(patch,['background','grid','text','up','down','crosshair']);this.model.theme={...this.model.theme,...next};return this.changed();}
 setSymbol(options) {
  const symbol=validateSymbol(options);zonedParts(0,symbol.timezone);
  this.model.symbol=symbol;this.model.precision=symbol.priceDecimals;this.model.priceFormatter=price=>formatPrice(price,symbol);
  this.model.timeFormatter=time=>{const p=zonedParts(time,symbol.timezone);return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;};rememberSymbolFormatters(this.model);return this.changed();
 }
 setVisibleRange(from,to) {this.model.setVisibleRange(from,to);return this.changed();}
 fit() {this.model.fit();return this.changed();}
 zoom(factor,anchor) {this.model.zoom(factor,anchor);return this.changed();}
 pan(delta) {this.model.pan(delta);return this.changed();}
 inspect() {return JSON.parse(JSON.stringify({view:this.model.view,theme:this.model.theme,panels:this.model.panels,axes:this.model.axes,drawingTarget:this.controller?.drawingTarget??null,series:this.model.series.map(({rangeIndex,values,revision,dirtyFrom,...s})=>({...s,...(values?{valueCount:values.length}:{})})),symbol:this.model.symbol,storedBars:this.model.store.length,lastBar:this.model.store.length?this.model.store.at(this.model.store.length-1):null,drawings:this.model.drawings.items,selected:this.model.drawings.selected,tool:this.controller?.tool??null,pointers:this.controller?.pointers.size??0,gesture:this.controller?.gesture?.kind??null}));}
}

// Portable workspace metadata only. Source bars and executable code stay host-owned.
const WORKSPACE_CHARS=2097152,WORKSPACE_BYTES=4194304;
const workspaceBindingKeys=['key','revision','adjustmentVersion','priceUnit','adjustment'];
const workspaceSymbolKeys=['id','exchange','timezone','currency','volumeUnit','priceDecimals','tickSize','adjustment'];
function workspaceSlot(object,key){const d=Object.getOwnPropertyDescriptor(object,key);if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Workspace own data slot: '+key);return d.value;}
function workspacePick(object,keys){const out={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(object,key);if(d){if(!Object.hasOwn(d,'value'))throw new TypeError('Workspace accessor: '+key);if(d.value!==undefined)Object.defineProperty(out,key,{value:d.value,enumerable:true,writable:true,configurable:true});}}return out;}
function workspaceRecord(value,keys,required=keys){optionRecord(value,keys,'Workspace');if(required.some(k=>!Object.hasOwn(value,k)))throw new TypeError('Workspace missing field');return value;}
// Count serialized scalar cost before materializing a potentially escape-heavy
// document. This deliberately rejects accessors/toJSON rather than invoking them.
function workspaceWalk(value,copy){let nodes=0,chars=0,bytes=0;const ancestors=new Set();const cost=(c,b=c)=>{chars+=c;bytes+=b;if(chars>WORKSPACE_CHARS||bytes>WORKSPACE_BYTES)throw new RangeError('Workspace document limit');};const string=s=>{cost(2);for(let i=0;i<s.length;i++){const n=s.charCodeAt(i);if(n===34||n===92)cost(2);else if(n<32)cost(6);else if(n<128)cost(1);else if(n<2048)cost(1,2);else if(n>=0xd800&&n<=0xdbff){const next=s.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new TypeError('Workspace Unicode scalar');cost(2,4);}else if(n>=0xdc00&&n<=0xdfff)throw new TypeError('Workspace Unicode scalar');else cost(1,3);}};
 const clone=(v,depth)=>{if(++nodes>250000||depth>32)throw new RangeError('Workspace node/depth limit');if(v===null){cost(4);return v;}if(typeof v==='string'){string(v);return v;}if(typeof v==='boolean'){cost(v?4:5);return v;}if(typeof v==='number'){if(!Number.isFinite(v))throw new TypeError('Workspace finite number');cost(Object.is(v,-0)?21:String(v).length);return v;}if(!v||typeof v!=='object'||ancestors.has(v))throw new TypeError('Workspace portable data required');const array=Array.isArray(v);if(Object.getPrototypeOf(v)!==(array?Array.prototype:Object.prototype)&&!(Object.getPrototypeOf(v)===null&&!array))throw new TypeError('Workspace plain data');const keys=Reflect.ownKeys(v),length=array?workspaceSlot(v,'length'):0;if(array&&(keys.length!==length+1||!Number.isSafeInteger(length)||length>250000))throw new TypeError('Workspace array shape');const out=copy?(array?[]:{}):v;let arrayIndex=0;cost(2);ancestors.add(v);for(const key of keys){if(array&&key==='length')continue;if(typeof key!=='string'||['__proto__','constructor','prototype','toJSON'].includes(key))throw new TypeError('Workspace reserved key');const d=Object.getOwnPropertyDescriptor(v,key);if(!d?.enumerable||!Object.hasOwn(d,'value')||array&&key!==String(arrayIndex++))throw new TypeError('Workspace own data fields');cost(1);if(!array){string(key);cost(1);}const item=clone(d.value,depth+1);if(copy)Object.defineProperty(out,key,{value:item,enumerable:true,writable:true,configurable:true});}ancestors.delete(v);return out;};return clone(value,0);
}
// Only parser-owned plain data may use the no-copy walk; external snapshots
// always detach. Both modes perform the identical complete bounded validation.
function workspaceSnapshot(value){return workspaceWalk(value,true);}
function workspaceBinding(value){const b=workspaceSnapshot(value);workspaceRecord(b,workspaceBindingKeys);for(const k of workspaceBindingKeys)boundedText(b[k],128,'Workspace dataset '+k);if(!['raw','split','total-return'].includes(b.adjustment))throw new TypeError('Workspace adjustment');return b;}
function workspaceBindingSame(a,b){return workspaceBindingKeys.every(k=>a[k]===b[k]);}
function validateWorkspaceDocument(doc){
 workspaceRecord(doc,['schema','version','dataset','source','chart','indicators','series','drawings']);if(doc.schema!=='aster.workspace'||doc.version!==1)throw new TypeError('Workspace schema/version');workspaceBinding(doc.dataset);
 const source=workspaceRecord(doc.source,['length','firstTime','lastTime']);sizeLimit(source.length,RESOURCE_LIMITS.maxBars,'Workspace source length');if(source.length===0){if(source.firstTime!==null||source.lastTime!==null)throw new TypeError('Empty workspace endpoints');}else if(!Number.isSafeInteger(source.firstTime)||!Number.isSafeInteger(source.lastTime)||Math.abs(source.firstTime)>8640000000000000||Math.abs(source.lastTime)>8640000000000000||source.lastTime<source.firstTime||source.length===1&&source.firstTime!==source.lastTime||source.length>1&&source.firstTime===source.lastTime)throw new TypeError('Workspace source endpoints');
 const c=workspaceRecord(doc.chart,['panels','axes','theme','symbol','formatters','precision','axisWidth','view','follow']);if(!Array.isArray(c.panels)||!c.panels.length||c.panels.length>32||!Array.isArray(c.axes)||c.axes.length>64||!Number.isInteger(c.precision)||c.precision<0||c.precision>18||!Number.isFinite(c.axisWidth)||c.axisWidth<20||typeof c.follow!=='boolean'||!['default','symbol'].includes(c.formatters))throw new TypeError('Workspace chart configuration');workspaceRecord(c.view,['from','to']);if(!Number.isFinite(c.view.from)||!Number.isFinite(c.view.to)||c.view.to<=c.view.from)throw new RangeError('Workspace view');
 workspaceRecord(c.theme,THEME_KEYS);portableStyle(c.theme,['background','grid','text','up','down','crosshair'],true);
 if(c.symbol!==null){workspaceRecord(c.symbol,workspaceSymbolKeys);for(const k of ['id','exchange','timezone','currency','volumeUnit'])boundedText(c.symbol[k],128,'Workspace symbol');validateSymbol(c.symbol);if(c.symbol.currency!==doc.dataset.priceUnit||c.symbol.adjustment!==doc.dataset.adjustment)throw new TypeError('Workspace symbol dataset units/adjustment');}else if(c.formatters==='symbol')throw new TypeError('Workspace symbol formatter metadata');
 if(!Array.isArray(doc.indicators)||doc.indicators.length>128||!Array.isArray(doc.series)||doc.series.length>256)throw new RangeError('Workspace study/series limit');
 const definitions=new Map();for(const e of doc.indicators){workspaceRecord(e,['id','name','params','module','outputs','plotOffsets'],['id','name','params','outputs','plotOffsets']);identifier(e.id,'Workspace indicator id');identifier(e.name,'Workspace indicator name');if(definitions.has(e.id))throw new TypeError('Duplicate workspace indicator');validateIndicatorParams(e.params);validateIndicatorModuleBinding(e.name,e.module);if(!Array.isArray(e.outputs)||!e.outputs.length||e.outputs.length>32||new Set(e.outputs).size!==e.outputs.length)throw new TypeError('Workspace output schema');for(const output of e.outputs)identifier(output,'Workspace output');workspaceRecord(e.plotOffsets,e.outputs,[]);for(const offset of Object.values(e.plotOffsets))if(!Number.isInteger(offset)||Math.abs(offset)>10000)throw new TypeError('Workspace output offset');definitions.set(e.id,e);}
 // Validate layout against an allocation-free facade. No indicator calculation,
 // BarStore subscriptions or source-array copies are needed for metadata parsing.
 const facade=Object.create(ChartModel.prototype);Object.assign(facade,{panels:[],axes:[],series:[],axisWidth:c.axisWidth,store:{length:source.length},indicators:{get(id){const e=definitions.get(id);if(!e)throw new Error('Missing workspace indicator');return {outputs:Object.fromEntries(e.outputs.map(k=>[k,null])),plotOffsets:e.plotOffsets};}}});
 for(const p of c.panels){workspaceRecord(p,PANEL_KEYS.filter(k=>k!=='formatter'),['id']);facade.addPanel(p);}for(const a of c.axes){workspaceRecord(a,AXIS_KEYS.filter(k=>k!=='formatter'),['id','panel']);facade.addAxis(a);}
 for(const s of doc.series){workspaceRecord(s,SERIES_KEYS.filter(k=>k!=='values'),['id','type','panel']);portableStyle(s,['color','fill','upColor','downColor'],true);facade.addSeries(s);}
 const drawings=workspaceRecord(doc.drawings,['schema','version','drawings']);if(drawings.schema!=='aster.drawings'||![1,2].includes(drawings.version)||!Array.isArray(drawings.drawings))throw new TypeError('Workspace drawing schema');const validator=new DrawingStore();if(drawings.drawings.length>validator.maxDrawings)throw new RangeError('Workspace drawing count');const ids=new Set();for(const d of drawings.drawings){validateDrawing(d);if(drawings.version===1&&(d.axisId!=null||d.seriesId!=null))throw new TypeError('Bound drawings require document version 2');facade.validateDrawingBinding(d);if(d.style)portableStyle(d.style,['color','fill'],true);if(ids.has(d.id))throw new TypeError('Duplicate drawing ids');ids.add(d.id);}validator.budget(drawings.drawings);
 return doc;
}
function readWorkspaceDocument(text){boundedText(text,WORKSPACE_CHARS,'Workspace document',true);let bytes=0;for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);bytes+=code<128?1:code<2048?2:code>=0xd800&&code<=0xdbff?(i++,4):3;if(bytes>WORKSPACE_BYTES)throw new RangeError('Workspace document byte limit');}const doc=workspaceWalk(safeCheckpointParse(text),false);return validateWorkspaceDocument(doc);}
function saveWorkspace(chart,datasetBinding){
 if(!(chart instanceof ChartAPI))throw new TypeError('Actual ChartAPI required');const model=workspaceSlot(chart,'model');if(!(model instanceof ChartModel)||model.disposed)throw new Error('Chart disposed');const controller=workspaceSlot(chart,'controller');if(controller&&(controller.gesture||controller.pointers?.size)||model.drawings.transaction)throw new Error('Commit or cancel gestures before saving workspace');if(!hasPortableFormatters(model))throw new TypeError('Workspace custom formatters unsupported');
 const store=model.store;if(!(store instanceof BarStore))throw new TypeError('Actual BarStore required');const version=workspaceSlot(store,'version'),columns=workspaceSlot(store,'columns'),length=workspaceSlot(store,'length');
 const indicators=[];for(const [id,e] of model.indicators.entries){requirePortableFactory(e.name,model.indicators.registry.get(e.name));indicators.push({id,name:e.name,params:workspacePick(e.params,Object.keys(e.params)),...((indicatorModule(e.name))?{module:indicatorModule(e.name)}:{}),outputs:e.def.outputs,plotOffsets:e.def.plotOffsets??{}});}
 const series=model.series.map(s=>{if(Object.hasOwn(s,'values')&&workspaceSlot(s,'values')!==undefined)throw new TypeError('Workspace external values unsupported');return workspacePick(s,SERIES_KEYS.filter(k=>k!=='values'));});
 const doc=workspaceSnapshot({schema:'aster.workspace',version:1,dataset:datasetBinding,source:{length,firstTime:length?columns.time[0]:null,lastTime:length?columns.time[length-1]:null},chart:{panels:model.panels.map(p=>workspacePick(p,PANEL_KEYS)),axes:model.axes.map(a=>workspacePick(a,AXIS_KEYS)),theme:model.theme,symbol:model.symbol??null,formatters:model.priceFormatter||model.timeFormatter?'symbol':'default',precision:model.precision,axisWidth:model.axisWidth,view:model.view,follow:model.follow},indicators,series,drawings:{schema:'aster.drawings',version:model.drawings.items.some(d=>d.axisId!=null||d.seriesId!=null)?2:1,drawings:model.drawings.items}});
 validateWorkspaceDocument(doc);const text=safeCheckpointStringify(doc);readWorkspaceDocument(text);if(model.disposed||chart.model!==model||model.store!==store||store.version!==version||store.columns!==columns||store.length!==length||model.drawings.transaction||controller&&(controller.gesture||controller.pointers?.size))throw new Error('Workspace owner changed during save');return text;
}
function installWorkspaceConfiguration(model,doc){
 const c=doc.chart,api=new ChartAPI(model);if(c.symbol!==null){if(c.formatters==='symbol')api.setSymbol(c.symbol);else model.symbol=Object.freeze({...c.symbol});}model.precision=c.precision;
 for(const s of doc.series)model.addSeries({...s});
 // Metadata validation already checked every anchor. Preserve exact finite
 // coordinates rather than nearest-bar snapping or another JSON normalization.
 model.drawings.items=doc.drawings.drawings.map(d=>Object.freeze({...d,points:Object.freeze(d.points.map(p=>Object.freeze({...p}))),...(d.style?{style:Object.freeze({...d.style})}:{})}));model.view={...c.view};model.follow=c.follow;return model;
}

// Native read-only metadata preflight. This is not calculation or restoration.
const nativeWorkspaceTypedProto=Object.getPrototypeOf(Float64Array.prototype),nativeWorkspaceLengthGet=Object.getOwnPropertyDescriptor(nativeWorkspaceTypedProto,'length').get,nativeWorkspaceBufferGet=Object.getOwnPropertyDescriptor(nativeWorkspaceTypedProto,'buffer').get,nativeWorkspaceTagGet=Object.getOwnPropertyDescriptor(nativeWorkspaceTypedProto,Symbol.toStringTag).get;
function nativeWorkspaceSame(a,b){return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));}
function nativeWorkspaceStale(){const error=new Error('Workspace preflight owner/source changed');error.name='StaleSourceError';throw error;}
function nativeWorkspacePreflight(api,text,datasetBinding){
 if(!(api instanceof ChartAPI))throw new TypeError('Actual ChartAPI required');const model=workspaceSlot(api,'model');if(!(model instanceof ChartModel)||model.disposed)throw new Error('Chart disposed');const store=workspaceSlot(model,'store');if(!(store instanceof BarStore))throw new TypeError('Actual BarStore required');
 const columns=workspaceSlot(store,'columns'),length=workspaceSlot(store,'length'),capacity=workspaceSlot(store,'capacity'),version=workspaceSlot(store,'version');if(!Number.isSafeInteger(length)||length<0||length>4194304||!Number.isSafeInteger(capacity)||capacity<16||capacity<length||capacity>4194304||(capacity&(capacity-1))||!Number.isSafeInteger(version))throw new RangeError('Workspace source dimensions/version');
 const source=FIELDS.map(k=>workspaceSlot(columns,k));for(const a of source){if(nativeWorkspaceTagGet.call(a)!=='Float64Array'||nativeWorkspaceLengthGet.call(a)<length)throw new TypeError('Workspace source columns');if(typeof SharedArrayBuffer!=='undefined'&&nativeWorkspaceBufferGet.call(a) instanceof SharedArrayBuffer)throw new TypeError('Shared workspace source');}
 const guard=()=>{if(workspaceSlot(api,'model')!==model||model.disposed||workspaceSlot(model,'store')!==store||workspaceSlot(store,'columns')!==columns||workspaceSlot(store,'version')!==version||workspaceSlot(store,'length')!==length||workspaceSlot(store,'capacity')!==capacity||FIELDS.some((k,i)=>workspaceSlot(columns,k)!==source[i]))nativeWorkspaceStale();};
 const binding=workspaceBinding(datasetBinding),doc=readWorkspaceDocument(text);guard();if(!workspaceBindingSame(doc.dataset,binding))throw new TypeError('Workspace dataset binding mismatch');if(doc.source.length!==length||doc.source.firstTime!==(length?source[0][0]:null)||doc.source.lastTime!==(length?source[0][length-1]:null))throw new TypeError('Workspace source extent mismatch');
 // Empty metadata-only engine: canonical factories run, but create/step and
 // checkpoint generation never do. It never subscribes to the live BarStore.
 const staging=new IndicatorEngine({length:0,capacity:0,columns:{},_subscribeInternal:()=>()=>{}}),modules=[],seenModules=new Set();let outputs=0,receipt;
 try{
  for(const study of doc.indicators){requirePortableFactory(study.name,staging.registry.get(study.name));staging.add(study.id,study.name,{...study.params});const entry=staging.entries.get(study.id);if(!nativeWorkspaceSame(entry.params,study.params))throw new TypeError('Workspace factory changed requested params');const layout=workspaceSnapshot({outputs:entry.def.outputs,plotOffsets:entry.def.plotOffsets??{}});if(layout.outputs.length!==study.outputs.length||layout.outputs.some((key,i)=>key!==study.outputs[i])||!nativeWorkspaceSame(layout.plotOffsets,study.plotOffsets))throw new TypeError('Workspace output schema/offset binding');outputs+=layout.outputs.length;if(outputs*capacity*8>staging.maxOutputBytes)throw new RangeError('Workspace projected output byte limit');if(study.module){const key=study.name;if(!seenModules.has(key)){seenModules.add(key);modules.push(workspaceSnapshot(study.module));}}guard();}
  receipt=workspaceSnapshot({schema:'aster.workspace-preflight',version:1,status:'validated-only',restored:false,dataset:binding,source:{length,firstTime:doc.source.firstTime,lastTime:doc.source.lastTime,version},counts:{panels:doc.chart.panels.length,axes:doc.chart.axes.length,series:doc.series.length,indicators:doc.indicators.length,outputs,drawings:doc.drawings.drawings.length},projectedOutputBytes:outputs*capacity*8,outputByteLimit:staging.maxOutputBytes,modules});
  // All module/metadata callbacks finish before this final callback-free guard.
  // No source vectors, indicator caches, history or native UI state are changed.
 }finally{staging.dispose();}
 guard();return receipt;
}

const asyncIds=new WeakMap();let asyncSerial=0;
function asyncIdentity(value){if(!value||typeof value!=='object'&&typeof value!=='function')return 0;if(!asyncIds.has(value))asyncIds.set(value,++asyncSerial);return asyncIds.get(value);}
function asyncConfigurationKey(model){return JSON.stringify([[...model.indicators.entries].map(([id,e])=>[id,asyncIdentity(e),e.name,e.params,asyncIdentity(e.def.create),asyncIdentity(model.indicators.registry.get(e.name))]),model.series.map(s=>[s.id,s.type,s.source,s.indicator,s.output,asyncIdentity(s.values)]),model.seriesValuesRevision??0]);}
function asyncOmit(value){if(Array.isArray(value))return value.map(asyncOmit);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,asyncOmit(v)]));return value;}
function asyncBindings(model){return [...model.indicators.entries].map(([id,e])=>({id,name:e.name,params:e.params,...(indicatorModule(e.name)?{module:indicatorModule(e.name)}:{}),outputs:e.def.outputs,plotOffsets:e.def.plotOffsets??{}}));}
function asyncBindingEqual(a,b){if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&asyncBindingEqual(a[k],b[k]));}
function asyncInteger(value,max,label){sizeLimit(value,max,label);return value;}
function asyncPower(value,label){if(!Number.isInteger(value)||value<16||value>RESOURCE_LIMITS.maxBars||(value&(value-1)))throw new TypeError(label);return value;}
const asyncPick=(value,keys)=>Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
// Validate restored series against the public model contract without calculating
// pending indicator vectors on the owner thread during snapshot restoration.
function asyncNormalizeSeries(model,options){const validator=Object.create(model);validator.indicators={get(id){const entry=model.indicators.entries.get(id);if(!entry)throw new Error('Missing indicator');return {outputs:Object.fromEntries(entry.def.outputs.map((name,i)=>[name,entry.arrays[i]])),plotOffsets:entry.def.plotOffsets??{}};}};return validator.normalizedSeries(options);}
function asyncEvent(event,store){if(!event||!['reset','append','update','correction','prepend','batch'].includes(event.kind))throw new TypeError('Async data event kind');if(event.kind==='batch')snapshotIngestionEvents(event.events);if(['append','update','correction'].includes(event.kind)){validateBar(event.bar);if(event.kind==='append'){if(store.length&&event.bar.time<=store.columns.time[store.length-1])throw new RangeError('Append time');}else if(event.kind==='update'){if(!store.length||event.bar.time!==store.columns.time[store.length-1])throw new RangeError('Update time');}else{const i=store.lowerBound(event.bar.time);if(i>=store.length||store.columns.time[i]!==event.bar.time)throw new RangeError('Correction time');}}return event;}
function asyncTree(index,put){return {size:index.size,min:put(index.min),max:put(index.max),sum:index.sum?put(index.sum):null,finiteCounts:index.finiteCounts===true};}
function asyncRestoreTree(meta,get,finiteCounts=false,countLimit=null){optionRecord(meta,['size','min','max','sum','finiteCounts'],'Async index');if(!Number.isInteger(meta.size)||meta.size<1||meta.size>RESOURCE_LIMITS.maxBars||(meta.size&(meta.size-1)))throw new TypeError('Async index size');if(meta.finiteCounts!==finiteCounts)throw new TypeError('Async finite-count cache role');const tree=Object.create(RangeIndex.prototype);Object.assign(tree,{size:meta.size,min:get(meta.min),max:get(meta.max),sum:meta.sum===null?null:get(meta.sum),finiteCounts});if(tree.min.length!==meta.size*2||tree.max.length!==meta.size*2||tree.sum&&tree.sum.length!==meta.size*2||countLimit!==null&&!tree.sum)throw new TypeError('Async index buffers');if(countLimit!==null){for(let i=tree.size;i<tree.size*2;i++)if(!Number.isInteger(tree.sum[i])||tree.sum[i]<0||tree.sum[i]>countLimit||finiteCounts&&tree.sum[i]!==Number(Number.isFinite(tree.min[i])&&Number.isFinite(tree.max[i])))throw new TypeError('Async finite-count cache leaf');for(let i=tree.size-1;i>0;i--)if(tree.sum[i]!==tree.sum[i*2]+tree.sum[i*2+1])throw new TypeError('Async finite-count cache aggregate');}return tree;}
class AsyncCapture {
 constructor(model,event){
  if((model.axes??[]).some(a=>a.formatter!==undefined))throw new TypeError('Async unsupported axis formatter callback');
  if(model.disposed)throw new Error('Async stale: model disposed');const release=acquireDataIngestionLease(model);try{this.model=model;this.sourceStore=model.store;this.event=asyncEvent(safeCheckpointParse(safeCheckpointStringify(event)),model.store);this.version=model.store.version;this.key=asyncConfigurationKey(model);this.revisions=[...model.indicators.entries].map(([id,e])=>[id,e.revision]);this.buffers=[];this.checkpoints=[];const byBuffer=new WeakMap();let bytes=0;
  const put=a=>{if(!(a instanceof Float64Array))throw new TypeError('Async Float64 buffer');let views=byBuffer.get(a.buffer);if(!views){views=new Map();byBuffer.set(a.buffer,views);}const key=a.byteOffset+':'+a.length;if(views.has(key))return {buffer:views.get(key)};bytes+=a.byteLength;if(bytes>536870912)throw new RangeError('Async snapshot byte limit');const slot=this.buffers.length;views.set(key,slot);this.buffers.push(a);return {buffer:slot};};
  const store=model.store,indicators=[...model.indicators.entries].map(([id,e],entry)=>{const module=requirePortableFactory(e.name,model.indicators.registry.get(e.name));validateIndicatorParams(e.params);const keys=[...e.checkpoints.keys()].sort((a,b)=>a-b);const maxRows=module||['period','fast','slow','signal','smoothK','smoothD','stochPeriod','atrPeriod','conversion','base','span'].some(k=>(e.params[k]??0)>100)?1:64;this.checkpoints.push({id,keys,map:e.checkpoints,maxRows});return {id,name:e.name,params:e.params,...(module?{module}:{}),outputs:e.def.outputs,plotOffsets:e.def.plotOffsets??{},arrays:e.arrays.map(put),checkpointCount:keys.length,checkpointSize:model.indicators.checkpointSize,revision:e.revision,dirty:e.dirty,dirtyTo:e.dirtyTo??store.length,invalidated:e.invalidated??true,length:e.length,computedFrom:e.computedFrom??0,computedUntil:e.computedUntil??store.length,entry};});
  const series=model.series.map(s=>{const options=asyncPick(s,SERIES_KEYS);if(s.values)options.values=put(s.values);const index=s.rangeIndex?.finiteCounts===true?s.rangeIndex:null;return {options,revision:s.revision,dirtyFrom:s.dirtyFrom??0,index:index?index instanceof BlockRangeIndex?{blocked:true,finiteCounts:true,size:index.size,length:index.length,blockSize:index.blockSize,tree:asyncTree(index.tree,put)}:{blocked:false,finiteCounts:true,tree:asyncTree(index,put)}:null};});
  const batchLimits=dataIngestionBatchLimits(model,this.event);
  this.metadata={schema:'aster.async.snapshot',protocol:1,event:this.event,...(batchLimits?{batchLimits}:{}),store:{length:store.length,capacity:store.capacity,maxBars:store.maxBars,timeframeMs:store.timeframeMs,timeOrigin:store.timeOrigin,version:store.version,timeVersion:store.timeVersion,columns:Object.fromEntries(FIELDS.map(k=>[k,put(store.columns[k])])),index:asyncTree(store.index,put)},panels:model.panels.map(p=>asyncPick(p,PANEL_KEYS.filter(k=>k!=='formatter'))),axes:(model.axes??[]).map(a=>asyncPick(a,AXIS_KEYS.filter(k=>k!=='formatter'))),theme:model.theme,precision:model.precision,axisWidth:model.axisWidth,indicators,series,bufferLengths:this.buffers.map(a=>a.length),maxOutputBytes:model.indicators.maxOutputBytes};
  this.metadataJSON=safeCheckpointStringify(asyncOmit(this.metadata));this.check();this.ingestionLease=release;}catch(error){release?.();throw error;}
 }
 check(){if(this.model.disposed||this.model.store!==this.sourceStore||this.model.store.version!==this.version||asyncConfigurationKey(this.model)!==this.key||this.revisions.some(([id,r])=>this.model.indicators.entries.get(id)?.revision!==r))throw new Error('Async stale: data/configuration/revision changed');return true;}
 buffer(slot,offset,count){this.check();const a=this.buffers[slot];if(!a||!Number.isInteger(offset)||!Number.isInteger(count)||offset<0||count<0||count>262144||offset+count>a.length)throw new RangeError('Async buffer slice');return Float64Array.prototype.subarray.call(a,offset,offset+count);}
 checkpoint(entry,offset,count){this.check();const row=this.checkpoints[entry];if(!row||!Number.isInteger(offset)||!Number.isInteger(count)||offset<0||count<1||count>row.maxRows||offset+count>row.keys.length)throw new RangeError('Async checkpoint slice');return safeCheckpointStringify(row.keys.slice(offset,offset+count).map(index=>[index,row.map.get(index)]));}
 uiState(input,size){this.check();const model=this.model,d=model.drawings;if(input?.gesture||d.transaction)throw new Error('Async stale: active gesture');if(model.panels.some(p=>p.formatter)||(model.axes??[]).some(a=>a.formatter!==undefined)||!hasPortableFormatters(model))throw new Error('Async unsupported formatter callback');const limits=asyncPick(d,['historyLimit','maxDrawings','maxPoints','maxDocumentChars','historyBytes']);const state={...(this.preparedInput?{preparedInput:this.preparedInput}:{}),...(model.dataIngestion?{dataIngestion:model.dataIngestion.save()}:{}),bindings:asyncBindings(model),view:model.view,follow:model.follow,crosshair:model.crosshair,theme:model.theme,panels:model.panels,axes:model.axes??[],drawingTarget:input?.drawingTarget??null,series:model.series.map(s=>asyncPick(s,SERIES_KEYS.filter(k=>!['values','indicator','output','source'].includes(k)))),precision:model.precision,axisWidth:model.axisWidth,symbol:model.symbol,drawings:{limits,items:d.items,undo:d.undoStack,redo:d.redoStack,selected:d.selected,serial:d.serial},tool:input?.tool??'select',text:input?.text??'',size};return state;}
 ui(input,size){const json=safeCheckpointStringify(asyncOmit(this.uiState(input,size)));if(json.length>8388608)throw new RangeError('Async UI state limit');return json;}
 release(){this.ingestionLease?.();this.ingestionLease=null;}
}
class AsyncPrepared {
 constructor(text){const meta=safeCheckpointParse(text);optionRecord(meta,['schema','protocol','event','batchLimits','store','panels','axes','theme','precision','axisWidth','indicators','series','bufferLengths','maxOutputBytes'],'Async metadata');if(meta.schema!=='aster.async.snapshot'||meta.protocol!==1||!Array.isArray(meta.bufferLengths)||meta.bufferLengths.length>1024||!Array.isArray(meta.indicators)||meta.indicators.length>128||!Array.isArray(meta.series)||meta.series.length>256)throw new TypeError('Async protocol');sizeLimit(meta.maxOutputBytes,536870912,'Async output budget');optionRecord(meta.store,['length','capacity','maxBars','timeframeMs','timeOrigin','version','timeVersion','columns','index'],'Async store');sizeLimit(meta.store.maxBars,RESOURCE_LIMITS.maxBars,'Async max bars');asyncPower(meta.store.capacity,'Async capacity');sizeLimit(meta.store.length,Math.min(meta.store.capacity,meta.store.maxBars),'Async length');for(const key of ['version','timeVersion'])sizeLimit(meta.store[key],Number.MAX_SAFE_INTEGER,'Async revision');for(const e of meta.indicators){optionRecord(e,['id','name','params','module','outputs','plotOffsets','arrays','checkpointCount','checkpointSize','revision','dirty','dirtyTo','invalidated','length','computedFrom','computedUntil','entry'],'Async indicator metadata');identifier(e.id,'Async indicator');requirePortableFactory(e.name,resolveIndicatorFactory(e.name));validateIndicatorModuleBinding(e.name,e.module);validateIndicatorParams(e.params);sizeLimit(e.checkpointSize,RESOURCE_LIMITS.maxBars+1,'Async checkpoint size');if(!e.checkpointSize||meta.indicators.some(q=>q.checkpointSize!==e.checkpointSize))throw new TypeError('Async checkpoint size');for(const key of ['revision','checkpointCount','length','computedFrom','computedUntil','dirtyTo'])if(e[key]!==undefined)sizeLimit(e[key],key==='revision'?Number.MAX_SAFE_INTEGER:RESOURCE_LIMITS.maxBars+1,'Async indicator '+key);if(e.dirty!==Infinity)sizeLimit(e.dirty,RESOURCE_LIMITS.maxBars,'Async dirty');if(typeof e.invalidated!=='boolean'||!Array.isArray(e.arrays))throw new TypeError('Async indicator shape');}let bytes=0;this.buffers=meta.bufferLengths.map(n=>{sizeLimit(n,RESOURCE_LIMITS.maxBars*2,'Async buffer');bytes+=n*8;if(bytes>536870912)throw new RangeError('Async buffer bytes');return new Float64Array(n);});this.received=this.buffers.map(()=>0);this.checkpoints=meta.indicators.map(()=>new Map());this.metadata=meta;this.model=null;this.phase='capture';this.entry=0;this.series=0;this.task=null;}
 target(slot,offset,count){const a=this.buffers[slot];if(!a||!Number.isInteger(offset)||!Number.isInteger(count)||offset!==this.received[slot]||count<1||count>262144||offset+count>a.length)throw new RangeError('Async target slice');this.received[slot]+=count;return a.subarray(offset,offset+count);}
 checkpoint(entry,text){const e=this.metadata.indicators[entry],map=this.checkpoints[entry],rows=safeCheckpointParse(text);if(!e||!Array.isArray(rows)||rows.length>64||!rows.length)throw new TypeError('Async checkpoint rows');for(const row of rows){if(!Array.isArray(row)||row.length!==2||row[0]!==map.size*e.checkpointSize||row[0]>e.length)throw new TypeError('Async checkpoint order/history');validateCheckpointState(e.name,e.params,row[1],row[0]);map.set(row[0],row[1]);}if(map.size>e.checkpointCount)throw new RangeError('Async checkpoint count');}
 start(){
  if(this.phase!=='capture'||this.received.some((n,i)=>n!==this.buffers[i].length))throw new Error('Async incomplete buffer capture');const m=this.metadata,s=m.store;if(m.batchLimits!==undefined){if(m.event.kind!=='batch')throw new TypeError('Async batch limits event');optionRecord(m.batchLimits,['maxBars','maxStoreBytes'],'Async batch limits');sizeLimit(m.batchLimits.maxBars,s.maxBars,'Async batch bar limit');sizeLimit(m.batchLimits.maxStoreBytes,96*RESOURCE_LIMITS.maxBars,'Async batch byte limit');}sizeLimit(s.length,s.maxBars,'Async bars');if(!Number.isInteger(s.capacity)||s.capacity<16||s.capacity>RESOURCE_LIMITS.maxBars||(s.capacity&(s.capacity-1))||s.length>s.capacity)throw new TypeError('Async capacity');
  const get=ref=>{optionRecord(ref,['buffer'],'Async buffer reference');sizeLimit(ref.buffer,this.buffers.length-1,'Async buffer slot');const a=this.buffers[ref.buffer];if(!a)throw new TypeError('Async buffer reference');return a;},store=new BarStore([],{maxBars:s.maxBars,timeframeMs:s.timeframeMs,timeOrigin:s.timeOrigin});Object.assign(store,{length:s.length,capacity:s.capacity,version:s.version,timeVersion:s.timeVersion,columns:Object.fromEntries(FIELDS.map(k=>[k,get(s.columns[k])])),index:asyncRestoreTree(s.index,get)});for(const a of Object.values(store.columns))if(a.length!==s.capacity)throw new TypeError('Async column length');if(store.index.size!==s.capacity||!store.index.sum)throw new TypeError('Async OHLC index');
  const model=new ChartModel({store,panels:m.panels,axes:m.axes??[],theme:m.theme,precision:m.precision,axisWidth:m.axisWidth});try{
   model.indicators.maxOutputBytes=m.maxOutputBytes;let outputBytes=0;for(let i=0;i<m.indicators.length;i++){const e=m.indicators[i];identifier(e.id,'Async indicator id');const make=resolveIndicatorFactory(e.name);if(!make||model.indicators.entries.has(e.id))throw new TypeError('Async indicator definition');const def=make(e.params),arrays=e.arrays.map(get);if(JSON.stringify(def.outputs)!==JSON.stringify(e.outputs)||JSON.stringify(def.plotOffsets??{})!==JSON.stringify(e.plotOffsets)||arrays.length!==def.outputs.length||arrays.some(a=>{try{asyncPower(a.length,'Async output capacity');return a.length!==arrays[0].length;}catch{return true;}}))throw new TypeError('Async output definition');outputBytes+=arrays.reduce((n,a)=>n+a.byteLength,0);if(outputBytes>m.maxOutputBytes)throw new RangeError('Async output bytes');if(this.checkpoints[i].size!==e.checkpointCount||e.checkpointCount&&e.checkpointCount!==Math.floor(e.length/e.checkpointSize)+1)throw new TypeError('Async checkpoint completeness');model.indicators.checkpointSize=e.checkpointSize;model.indicators.entries.set(e.id,{...e,def,arrays,checkpoints:this.checkpoints[i]});}
   model.series=m.series.map(row=>{const restored={...row.options};if(restored.values)restored.values=get(restored.values);const options=asyncNormalizeSeries(model,restored),entry=options.indicator?model.indicators.entries.get(options.indicator):null,values=entry?entry.arrays[entry.def.outputs.indexOf(options.output??entry.def.outputs[0])]:options.values??store.columns[options.source??'close'];if(!values)throw new TypeError('Async series output');let index=null;if(row.index){if(row.index.finiteCounts!==true||typeof row.index.blocked!=='boolean')throw new TypeError('Async finite-count cache marker');if(row.index.blocked){if(row.index.blockSize!==32||!Number.isInteger(row.index.length)||row.index.length<0||row.index.length>row.index.size)throw new TypeError('Async block index');asyncPower(row.index.size,'Async cached capacity');let treeSize=1;while(treeSize<Math.ceil(row.index.size/32))treeSize*=2;if(row.index.tree.size!==treeSize)throw new TypeError('Async block tree');index=Object.create(BlockRangeIndex.prototype);Object.assign(index,{size:row.index.size,length:row.index.length,blockSize:32,values,tree:asyncRestoreTree(row.index.tree,get,false,32),finiteCounts:true});}else index=asyncRestoreTree(row.index.tree,get,true,1);if((index instanceof BlockRangeIndex?index.tree.sum:index.sum).buffer===store.index.sum.buffer)throw new TypeError('Async finite-count cache aliases volume');}return {...options,revision:row.revision,dirtyFrom:row.dirtyFrom,rangeIndex:index};});if(new Set(model.series.map(s=>s.id)).size!==model.series.length)throw new TypeError('Async duplicate series');
   asyncEvent(m.event,store);if(m.event.kind==='batch'&&m.batchLimits)store.applyEvents(m.event.events,m.batchLimits);else applyDataEvent(store,m.event);this.model=model;this.phase='calculate';
  }catch(error){model.dispose();throw error;}
 }
 step(maxBars=4096){if(!this.model)throw new Error('Async calculation not started');const model=this.model,ids=[...model.indicators.entries.keys()];if(this.phase==='calculate'){if(this.entry<ids.length){if(!this.task)this.task=model.indicators.calculate(ids[this.entry],maxBars);const next=this.task.next();if(next.done){this.task=null;this.entry++;}return {phase:'calculate',done:this.entry,total:ids.length,complete:false};}this.phase='indices';}
  if(this.phase==='indices'){if(this.series<model.series.length){const s=model.series[this.series++];if(!['candles','ohlc'].includes(s.type))model.seriesData(s);return {phase:'indices',done:this.series,total:model.series.length,complete:false};}this.phase='ready';}return {phase:'ready',done:1,total:1,complete:true};}
 finish(text){return this.finishUI(safeCheckpointParse(text));}
 finishUI(ui,restoredDrawings=null){
  if(this.phase!=='ready')throw new Error('Async result not ready');const model=this.model;
  optionRecord(ui,['preparedInput','dataIngestion','bindings','view','follow','crosshair','theme','panels','axes','drawingTarget','series','precision','axisWidth','symbol','drawings','tool','text','size'],'Async UI state');
  if(this.metadata.event.kind==='prepare'){const expected={input:this.metadata.input,version:this.metadata.version,timeVersion:this.metadata.timeVersion,storeOptions:this.metadata.storeOptions,maxOutputBytes:this.metadata.maxOutputBytes};if(!asyncBindingEqual(ui.preparedInput,expected))throw new Error('Prepare stale: request/input binding');}else if(ui.preparedInput!==undefined)throw new TypeError('Async unsupported preparation signature');
  if(!asyncBindingEqual(ui.bindings,asyncBindings(model)))throw new Error('Async stale: indicator request binding');
  optionRecord(ui.view,['from','to'],'Async view');if(!Number.isFinite(ui.view.from)||!Number.isFinite(ui.view.to)||ui.view.to<=ui.view.from||typeof ui.follow!=='boolean')throw new TypeError('Async view');
  optionRecord(ui.size,['width','height'],'Async size');if(!Number.isFinite(ui.size.width)||ui.size.width<100||ui.size.width>RESOURCE_LIMITS.maxCanvasDimension||!Number.isFinite(ui.size.height)||ui.size.height<80||ui.size.height>RESOURCE_LIMITS.maxCanvasDimension)throw new TypeError('Async size');
  if(ui.crosshair!==null){optionRecord(ui.crosshair,['x','y'],'Async crosshair');if(!Number.isFinite(ui.crosshair.x)||!Number.isFinite(ui.crosshair.y))throw new TypeError('Async crosshair');}
  sizeLimit(ui.precision,18,'Async precision');if(!Number.isFinite(ui.axisWidth)||ui.axisWidth<20)throw new TypeError('Async axis width');optionRecord(ui.theme,THEME_KEYS,'Async theme');const theme=portableStyle(ui.theme,['background','grid','text','up','down','crosshair'],true);if(ui.symbol)validateSymbol(ui.symbol);
  if(!Array.isArray(ui.panels)||!ui.panels.length||ui.panels.length>32||!Array.isArray(ui.series)||ui.series.length!==model.series.length)throw new TypeError('Async UI collections');
  const panels=[];for(const p of ui.panels){optionRecord(p,PANEL_KEYS,'Async panel');identifier(p.id,'Async panel');if(p.formatter!==undefined)throw new TypeError('Async unsupported panel formatter callback');model.validatePanel(p);if(panels.some(q=>q.id===p.id))throw new TypeError('Async duplicate panel');panels.push(p);}
  const axisValidator=Object.create(model);axisValidator.panels=panels;axisValidator.axes=[];if(!Array.isArray(ui.axes??[]))throw new TypeError('Async UI axes');for(const axis of ui.axes??[]){optionRecord(axis,AXIS_KEYS,'Async axis');if(axis.formatter!==undefined)throw new TypeError('Async unsupported axis formatter callback');axisValidator.addAxis(axis);}const axes=axisValidator.axes;
  if(model.series.some(s=>!panels.some(p=>p.id===s.panel)))throw new Error('Async stale: panel binding');
  const patches=new Map();for(const patch of ui.series){optionRecord(patch,SERIES_KEYS.filter(k=>!['values','indicator','output','source'].includes(k)),'Async series patch');const s=model.series.find(s=>s.id===patch.id);if(!s||patches.has(patch.id)||s.type!==patch.type||s.panel!==patch.panel)throw new Error('Async stale: series binding');const next=portableStyle(patch,['color','fill','upColor','downColor'],true);axisValidator.normalizedSeries({...asyncPick(s,SERIES_KEYS),...next});patches.set(s.id,next);}
  axisValidator.series=model.series.map(s=>({...s,...patches.get(s.id)}));let drawingTarget=ui.drawingTarget??null;if(drawingTarget!==null){optionRecord(drawingTarget,['panel','axisId','seriesId'],'Async drawing target');identifier(drawingTarget.panel,'Async drawing target panel');axisValidator.validateDrawingBinding(drawingTarget,{allowOrphanSeries:true});const linked=drawingTarget.seriesId?axisValidator.series.find(s=>s.id===drawingTarget.seriesId):null;if(drawingTarget.seriesId&&(!linked||linked.panel!==drawingTarget.panel||(linked.axisId??null)!==(drawingTarget.axisId??null)))drawingTarget=null;else axisValidator.validateDrawingBinding(drawingTarget);}
  optionRecord(ui.drawings,['limits','items','undo','redo','selected','serial'],'Async drawings');const store=restoredDrawings??new DrawingStore(ui.drawings.limits),memo=new Map();
  if(!Array.isArray(ui.drawings.undo)||!Array.isArray(ui.drawings.redo)||ui.drawings.undo.length>store.historyLimit||ui.drawings.redo.length>store.historyLimit)throw new TypeError('Async drawing history');
  const restore=items=>{const key=safeCheckpointStringify(items);if(memo.has(key))return memo.get(key);const temp=new DrawingStore(ui.drawings.limits);temp.load(JSON.stringify({schema:'aster.drawings',version:items.some(d=>d.axisId!=null||d.seriesId!=null)?2:1,drawings:items}),{styleDecoder:style=>portableStyle(style,['color','fill'],true),validatePanel:id=>panels.some(p=>p.id===id),validateBinding:d=>axisValidator.validateDrawingBinding(d,{allowOrphanSeries:true})});const records=temp.items;memo.set(key,records);return records;};
  if(!restoredDrawings){store.items=restore(ui.drawings.items);store.undoStack=ui.drawings.undo.map(restore);store.redoStack=ui.drawings.redo.map(restore);}if(ui.drawings.selected!==null&&!store.items.some(d=>d.id===ui.drawings.selected))throw new TypeError('Async selection');sizeLimit(ui.drawings.serial,Number.MAX_SAFE_INTEGER,'Async drawing serial');store.selected=ui.drawings.selected;store.serial=ui.drawings.serial;store.trim();
  // Legacy preparation can replace history outside this opt-in admission
  // budget; preserve the empty policy/ledger across VM swap without eviction.
  const ingestion=ui.dataIngestion===undefined?null:restoreDataIngestion(model,ui.dataIngestion,{allowBudgetMismatch:this.metadata.event.kind!=='batch'});if(ingestion?.count){ingestion.dispose();throw new Error('Async ingestion payload must be empty');}
  for(const s of model.series)Object.assign(s,patches.get(s.id));model.dataIngestion?.dispose();model.dataIngestion=ingestion;model.drawings=store;model.panels=panels;model.axes=axes;model.theme=theme;model.precision=ui.precision;model.axisWidth=ui.axisWidth;model.view={...ui.view};model.follow=ui.follow;model.crosshair=ui.crosshair;const event=this.metadata.event;if(event.kind==='prepend'){model.view.from+=event.bars.length;model.view.to+=event.bars.length;}else if(event.kind==='reset')model.fit();else if((event.kind==='append'||event.kind==='batch'&&event.events.some(e=>e.kind==='append'))&&model.follow){const span=model.view.to-model.view.from;model.view.to=model.store.length+model.forwardOffset()-.5;model.view.from=model.view.to-span;}return {model,ui:{...ui,drawingTarget}};
 }
 dispose(){this.model?.dispose();this.model=null;this.buffers=[];this.checkpoints=[];}
}

const preparePick=(value,keys)=>Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
function prepareRequest(request){optionRecord(request,['kind','length','count','seed','visibleBars'],'Prepare request');if(!['columns','seeded'].includes(request.kind))throw new TypeError('Prepare input kind');const length=request.kind==='columns'?request.length:request.count;sizeLimit(length,RESOURCE_LIMITS.maxBars,'Prepare bar count');const seed=request.seed??42;sizeLimit(seed,4294967295,'Prepare seed');const visibleBars=request.visibleBars??200;if(!Number.isFinite(visibleBars)||visibleBars<1||visibleBars>RESOURCE_LIMITS.maxBars)throw new RangeError('Prepare visible bars');return {kind:request.kind,length,seed,visibleBars};}
function prepareOffsetsSame(a,b){if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)||Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&Object.is(a[k],b[k]));}
function prepareDefinitions(indicators){if(!Array.isArray(indicators)||indicators.length>128)throw new TypeError('Prepare indicators');const ids=new Set();let outputs=0;for(const e of indicators){optionRecord(e,['id','name','params','module','outputs','plotOffsets'],'Prepare indicator');identifier(e.id,'Prepare indicator id');if(ids.has(e.id))throw new TypeError('Prepare duplicate indicator');ids.add(e.id);const factory=resolveIndicatorFactory(e.name);requirePortableFactory(e.name,factory);validateIndicatorModuleBinding(e.name,e.module);validateIndicatorParams(e.params);const d=factory(e.params);if(JSON.stringify(d.outputs)!==JSON.stringify(e.outputs)||!prepareOffsetsSame(d.plotOffsets??{},e.plotOffsets))throw new TypeError('Prepare output definition');outputs+=d.outputs.length;}return outputs;}
class PrepareCapture {
 constructor(model,request){if((model.axes??[]).some(a=>a.formatter!==undefined))throw new TypeError('Prepare unsupported axis formatter callback');if(model.disposed)throw new Error('Prepare stale: source disposed');const release=acquireDataIngestionLease(model);try{this.model=model;this.sourceStore=model.store;this.version=model.store.version;this.key=asyncConfigurationKey(model);const input=prepareRequest(request);sizeLimit(input.length,model.store.maxBars,'Prepare source bar limit');this.buffers=[];this.checkpoints=[];
  const indicators=[...model.indicators.entries].map(([id,e])=>{const module=requirePortableFactory(e.name,model.indicators.registry.get(e.name));validateIndicatorParams(e.params);return {id,name:e.name,params:{...e.params},...(module?{module}:{}),outputs:[...e.def.outputs],plotOffsets:{...e.def.plotOffsets}};});
  const series=model.series.map(s=>{if(s.values)throw new TypeError('Prepare borrowed series values unsupported');return preparePick(s,SERIES_KEYS);});
  this.metadata={schema:'aster.prepare',protocol:1,input,storeOptions:{maxBars:model.store.maxBars,timeframeMs:model.store.timeframeMs,timeOrigin:model.store.timeOrigin},version:model.store.version+1,timeVersion:model.store.timeVersion+1,panels:model.panels.map(p=>preparePick(p,PANEL_KEYS.filter(k=>k!=='formatter'))),axes:(model.axes??[]).map(a=>preparePick(a,AXIS_KEYS.filter(k=>k!=='formatter'))),theme:{...model.theme},precision:model.precision,axisWidth:model.axisWidth,indicators,series,maxOutputBytes:model.indicators.maxOutputBytes};this.preparedInput={input:{...input},version:this.metadata.version,timeVersion:this.metadata.timeVersion,storeOptions:{...this.metadata.storeOptions},maxOutputBytes:this.metadata.maxOutputBytes};this.metadataJSON=safeCheckpointStringify(this.metadata);this.check();this.ingestionLease=release;}catch(error){release?.();throw error;}
 }
 check(){if(this.model.disposed||this.model.store!==this.sourceStore||this.model.store.version!==this.version||asyncConfigurationKey(this.model)!==this.key)throw new Error('Prepare stale: data/configuration changed');return true;}
 uiState(input,size){return AsyncCapture.prototype.uiState.call(this,input,size);}
 ui(input,size){return AsyncCapture.prototype.ui.call(this,input,size);}
 release(){return AsyncCapture.prototype.release.call(this);}
}
class PreparedData {
 constructor(text){const m=safeCheckpointParse(text);optionRecord(m,['schema','protocol','input','storeOptions','version','timeVersion','panels','axes','theme','precision','axisWidth','indicators','series','maxOutputBytes'],'Prepare metadata');if(m.schema!=='aster.prepare'||m.protocol!==1)throw new TypeError('Prepare protocol');optionRecord(m.input,['kind','length','seed','visibleBars'],'Prepare input');const request=prepareRequest({kind:m.input.kind,...(m.input.kind==='columns'?{length:m.input.length}:{count:m.input.length}),seed:m.input.seed,visibleBars:m.input.visibleBars});this.length=request.length;this.input=request;let cap=16;while(cap<this.length)cap*=2;this.capacity=cap;sizeLimit(m.maxOutputBytes,536870912,'Prepare output budget');const outputs=prepareDefinitions(m.indicators);if(outputs*cap*8>m.maxOutputBytes)throw new RangeError('Prepare indicator output budget');if(cap*8*(12+outputs)>805306368)throw new RangeError('Prepare retained typed-byte budget');if(!Array.isArray(m.series)||m.series.length>256)throw new TypeError('Prepare series');for(const s of m.series){optionRecord(s,SERIES_KEYS.filter(k=>k!=='values'),'Prepare series');identifier(s.id,'Prepare series id');}
  optionRecord(m.storeOptions,['maxBars','timeframeMs','timeOrigin'],'Prepare store options');sizeLimit(m.storeOptions.maxBars,RESOURCE_LIMITS.maxBars,'Prepare bar limit');if(!Number.isFinite(m.storeOptions.timeframeMs)||m.storeOptions.timeframeMs<=0||!Number.isFinite(m.storeOptions.timeOrigin))throw new TypeError('Prepare timeframe/origin');sizeLimit(this.length,m.storeOptions.maxBars,'Prepare bars');for(const key of ['version','timeVersion'])sizeLimit(m[key],Number.MAX_SAFE_INTEGER,'Prepare revision');this.metadata={...m,event:{kind:'prepare'}};this.columns=Object.fromEntries(FIELDS.map(k=>[k,new Float64Array(cap)]));this.received=FIELDS.map(()=>0);this.model=null;this.phase='capture';this.at=0;this.previous=-Infinity;this.seed=request.seed;this.price=100;this.entry=0;this.series=0;this.task=null;this.initialView=null;}
 target(slot,offset,count){if(this.phase!=='capture'||this.input.kind!=='columns'||!Number.isInteger(slot)||slot<0||slot>=6||!Number.isInteger(offset)||!Number.isInteger(count)||offset!==this.received[slot]||count<1||count>262144||offset+count>this.length)throw new RangeError('Prepare target slice');this.received[slot]+=count;return this.columns[FIELDS[slot]].subarray(offset,offset+count);}
 start(){if(this.phase!=='capture'||this.input.kind==='columns'&&this.received.some(n=>n!==this.length))throw new Error('Prepare incomplete input');this.store=new BarStore([],this.metadata.storeOptions);const cap=this.capacity,tree=Object.create(RangeIndex.prototype);Object.assign(tree,{size:cap,min:new Float64Array(cap*2).fill(Infinity),max:new Float64Array(cap*2).fill(-Infinity),sum:new Float64Array(cap*2),finiteCounts:false});Object.assign(this.store,{length:this.length,capacity:cap,columns:this.columns,index:tree,version:this.metadata.version,timeVersion:this.metadata.timeVersion});this.phase=this.input.kind==='seeded'?'generate':'validate';this.at=0;}
 progress(done,total,complete=false){return {phase:this.phase,done,total,complete};}
 step(maxBars=4096){if(!Number.isInteger(maxBars)||maxBars<1||maxBars>65536)throw new RangeError('Prepare step size');if(this.phase==='capture')throw new Error('Prepare not started');const c=this.columns,n=this.length;
  if(this.phase==='generate'){const end=Math.min(n,this.at+maxBars),rand=()=>{this.seed=(Math.imul(this.seed,1664525)+1013904223)>>>0;return this.seed/4294967296;};for(;this.at<end;this.at++){const i=this.at,open=this.price;this.price=Math.max(.1,this.price+(rand()-.497)*1.2);c.time[i]=1700000000000+i*60000;c.open[i]=open;c.close[i]=this.price;c.high[i]=Math.max(open,this.price)+rand()*.6;c.low[i]=Math.max(.01,Math.min(open,this.price)-rand()*.6);c.volume[i]=Math.floor(100+rand()*9900);}const r=this.progress(this.at,n);if(this.at===n){this.phase='validate';this.at=0;}return r;}
  if(this.phase==='validate'){const end=Math.min(n,this.at+maxBars);for(;this.at<end;this.at++){const i=this.at,t=c.time[i],o=c.open[i],h=c.high[i],l=c.low[i],v=c.volume[i],close=c.close[i];if(!Number.isFinite(t)||!Number.isFinite(o)||!Number.isFinite(h)||!Number.isFinite(l)||!Number.isFinite(close)||!Number.isFinite(v))throw new TypeError('Every OHLCV field must be finite');if(!Number.isSafeInteger(t)||Math.abs(t)>8640000000000000)throw new RangeError('OHLCV UTC time');if(t<=this.previous)throw new RangeError('OHLCV increasing time');if(v<0||l>Math.min(o,close)||h<Math.max(o,close)||l>h)throw new RangeError('Invalid OHLCV envelope');this.previous=t;this.store.index.leaf(i,l,h,v);}const r=this.progress(this.at,n);if(this.at===n){this.phase='store-index';this.at=this.capacity-1;}return r;}
  if(this.phase==='store-index'){const stop=Math.max(0,this.at-maxBars);for(;this.at>stop;this.at--)this.store.index.merge(this.at);const r=this.progress(this.capacity-1-this.at,this.capacity-1);if(this.at===0){if(!Number.isFinite(this.store.index.sum[1]))throw new RangeError('Volume sum overflow');this.initialize();this.phase='calculate';}return r;}
  if(this.phase==='calculate'){const ids=[...this.model.indicators.entries.keys()];if(this.entry<ids.length){if(!this.task)this.task=this.model.indicators.calculate(ids[this.entry],maxBars);const result=this.task.next();if(result.done){this.task=null;this.entry++;}return this.progress(this.entry,ids.length);}for(const options of this.metadata.series)this.model.addSeries(options);this.initialView={...this.model.view};this.phase='indices';this.series=0;}
  if(this.phase==='indices'){if(this.series<this.model.series.length){const series=this.model.series[this.series];if(!['candles','ohlc'].includes(series.type)){if(!this.task)this.task=this.range(series,maxBars);const result=this.task.next();if(result.done){this.task=null;this.series++;}}else this.series++;return this.progress(this.series,this.model.series.length);}this.phase='ready';}return this.progress(1,1,true);
 }
 initialize(){const m=this.metadata;this.model=new ChartModel({store:this.store,panels:m.panels,axes:m.axes??[],theme:m.theme,precision:m.precision,axisWidth:m.axisWidth,visibleBars:this.input.visibleBars});this.model.indicators.maxOutputBytes=m.maxOutputBytes;for(const e of m.indicators){const def=resolveIndicatorFactory(e.name)(e.params);this.model.indicators.entries.set(e.id,{def,name:e.name,params:{...e.params},dirty:0,dirtyTo:this.length,invalidated:true,length:0,arrays:[],checkpoints:new Map(),revision:0});}}
 *range(series,maxBars){const model=this.model,entry=series.indicator?model.indicators.entries.get(series.indicator):null,values=entry?entry.arrays[entry.def.outputs.indexOf(series.output??entry.def.outputs[0])]:this.columns[series.source??'close'],blocked=this.length>=SERIES_BLOCK_THRESHOLD,blockSize=blocked?32:1,leaves=Math.ceil(this.length/blockSize);let treeSize=1;while(treeSize<Math.ceil(this.capacity/blockSize))treeSize*=2;const tree=Object.create(RangeIndex.prototype);Object.assign(tree,{size:treeSize,min:new Float64Array(treeSize*2).fill(Infinity),max:new Float64Array(treeSize*2).fill(-Infinity),sum:new Float64Array(treeSize*2),finiteCounts:!blocked});const rows=Math.max(1,Math.floor(maxBars/blockSize));for(let start=0;start<leaves;start+=rows){const end=Math.min(leaves,start+rows);for(let b=start;b<end;b++){let lo=Infinity,hi=-Infinity,finite=0;for(let i=b*blockSize;i<Math.min(this.length,(b+1)*blockSize);i++){const v=values[i];if(Number.isFinite(v)){lo=Math.min(lo,v);hi=Math.max(hi,v);finite++;}}tree.leaf(b,lo,hi,finite);}yield end;}for(let start=treeSize-1;start>0;){const end=Math.max(0,start-maxBars);for(;start>end;start--)tree.merge(start);yield start;}if(blocked){const index=Object.create(BlockRangeIndex.prototype);Object.assign(index,{size:this.capacity,length:this.length,blockSize,values,tree,finiteCounts:true});series.rangeIndex=index;}else series.rangeIndex=tree;series.revision=entry?entry.revision:this.store.version;series.dirtyFrom=Infinity;}
 finish(text){return this.finishUI(safeCheckpointParse(text));}
 finishUI(ui,drawings=null){const result=AsyncPrepared.prototype.finishUI.call(this,ui,drawings);if(result.ui.follow){this.model.view={...this.initialView};this.model.follow=true;}return result;}
 dispose(){this.model?.dispose();this.model=null;this.columns={};this.store=null;this.task=null;}
}

// Isolated native restore target protocol. This does not publish a host runtime.
const NATIVE_WORKSPACE_RESTORE_BYTES=805306368;
function nativeTargetInteger(n,min,max,label){if(!Number.isSafeInteger(n)||n<min||n>max)throw new RangeError('Native workspace '+label);return n;}
function nativeTargetEqual(a,b){if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&nativeTargetEqual(a[k],b[k]));}
function nativeTargetPick(value,keys){const out={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);if(d){if(!Object.hasOwn(d,'value'))throw new TypeError('Native workspace target accessor');if(d.value!==undefined)out[k]=d.value;}}return out;}
function nativeTargetNormalized(doc){const definitions=new Map(doc.indicators.map(e=>[e.id,e])),facade=Object.create(ChartModel.prototype);Object.assign(facade,{panels:[],axes:[],series:[],axisWidth:doc.chart.axisWidth,store:{length:doc.source.length},indicators:{get(id){const e=definitions.get(id);if(!e)throw new Error('Native workspace indicator binding');return {outputs:Object.fromEntries(e.outputs.map(k=>[k,null])),plotOffsets:e.plotOffsets};}}});for(const p of doc.chart.panels)facade.addPanel(p);for(const a of doc.chart.axes)facade.addAxis(a);for(const item of doc.series)facade.addSeries(item);return {...doc,drawings:{...doc.drawings,version:doc.drawings.drawings.some(d=>d.axisId!=null||d.seriesId!=null)?2:1},chart:{...doc.chart,panels:facade.panels.map(p=>nativeTargetPick(p,PANEL_KEYS.filter(k=>k!=='formatter'))),axes:facade.axes.map(a=>nativeTargetPick(a,AXIS_KEYS.filter(k=>k!=='formatter')))},series:facade.series.map(e=>nativeTargetPick(e,SERIES_KEYS.filter(k=>k!=='values')))};}
function nativeTargetSpec(text){
 if(typeof text!=='string'||text.length>8388608)throw new RangeError('Native workspace target metadata');const m=safeCheckpointParse(text);optionRecord(m,['schema','version','document','datasetBinding','source','size','retainedBytes','maxBytes','dataIngestion'],'Native workspace target');if(m.schema!=='aster.native-workspace-target'||m.version!==1)throw new TypeError('Native workspace target protocol');
 const doc=readWorkspaceDocument(m.document);if(!workspaceBindingSame(doc.dataset,workspaceBinding(m.datasetBinding)))throw new TypeError('Native workspace target dataset binding');
 const s=m.source;optionRecord(s,['length','maxBars','timeframeMs','timeOrigin','version','timeVersion'],'Native workspace target source');nativeTargetInteger(s.length,0,RESOURCE_LIMITS.maxBars,'source length');nativeTargetInteger(s.maxBars,0,RESOURCE_LIMITS.maxBars,'source max bars');if(s.length>s.maxBars||doc.source.length!==s.length||!Number.isFinite(s.timeframeMs)||s.timeframeMs<=0||!Number.isFinite(s.timeOrigin))throw new RangeError('Native workspace target source settings');nativeTargetInteger(s.version,0,Number.MAX_SAFE_INTEGER-1,'source version');nativeTargetInteger(s.timeVersion,0,Number.MAX_SAFE_INTEGER-1,'source time version');
 optionRecord(m.size,['width','height'],'Native workspace target size');for(const n of [m.size.width,m.size.height])if(!Number.isFinite(n)||n<1||n>RESOURCE_LIMITS.maxCanvasDimension)throw new RangeError('Native workspace target size');if(m.size.width*m.size.height>RESOURCE_LIMITS.maxCanvasPixels)throw new RangeError('Native workspace target pixel limit');
 const maxBytes=nativeTargetInteger(m.maxBytes,1,NATIVE_WORKSPACE_RESTORE_BYTES,'combined byte limit'),retainedBytes=nativeTargetInteger(m.retainedBytes,0,maxBytes,'retained source bytes');let capacity=16;while(capacity<s.length)capacity*=2;const outputs=doc.indicators.reduce((n,e)=>n+e.outputs.length,0),outputBytes=outputs*capacity*8;if(outputBytes>268435456)throw new RangeError('Native workspace target output byte limit');
 let dataIngestion=null,ingestionBytes=0;if(m.dataIngestion!==undefined){if(typeof m.dataIngestion!=='string'||m.dataIngestion.length>32768)throw new RangeError('Native workspace ingestion document limit');const facade={disposed:false,dataIngestion:null,store:{length:s.length,capacity,maxBars:s.maxBars,version:s.version,bytes:capacity*96}};const candidate=restoreDataIngestion(facade,m.dataIngestion);facade.dataIngestion=candidate;try{if(candidate.count)throw new TypeError('Native workspace pending ingestion');dataIngestion=candidate.save();ingestionBytes=candidate.capacity*49*3;}finally{candidate.dispose();}}
 const indexedSeries=doc.series.filter(e=>!['candles','ohlc'].includes(e.type)).length,indexCapacity=s.length>=SERIES_BLOCK_THRESHOLD?Math.max(1,capacity/32):capacity,sourceBytes=capacity*96,rangeBytes=indexedSeries*indexCapacity*48,checkpointRecords=(s.length===0?0:Math.floor(s.length/256)+1)*doc.indicators.length;
 // Explicit logical reservation: source columns+store index, output vectors,
 // derived indexes, bounded encoded records, record metadata, decode/validation
 // scratch, document copies and two maximum transfer buffers. Not process RSS.
 const checkpointBytes=NATIVE_CHECKPOINT_TOTAL_BYTES,recordMetadataBytes=checkpointRecords*128,scratchBytes=33554432,documentBytes=33554432,transferBytes=4194304,totalBytes=retainedBytes+sourceBytes+outputBytes+rangeBytes+checkpointBytes+recordMetadataBytes+scratchBytes+documentBytes+transferBytes+ingestionBytes;if(totalBytes>maxBytes)throw new RangeError('Native workspace combined logical byte limit');
 const plan=Object.freeze({retainedBytes,sourceBytes,outputBytes,rangeBytes,checkpointBytes,recordMetadataBytes,scratchBytes,documentBytes,transferBytes,ingestionBytes,totalBytes,maxBytes,capacity,outputs});
 const metadata={schema:'aster.prepare',protocol:1,input:{kind:'columns',length:s.length,seed:42,visibleBars:Math.max(1,doc.chart.view.to-doc.chart.view.from)},storeOptions:{maxBars:s.maxBars,timeframeMs:s.timeframeMs,timeOrigin:s.timeOrigin},version:s.version+1,timeVersion:s.timeVersion+1,panels:doc.chart.panels,axes:doc.chart.axes,theme:doc.chart.theme,precision:doc.chart.precision,axisWidth:doc.chart.axisWidth,indicators:doc.indicators,series:doc.series,maxOutputBytes:268435456};
 // Keep PreparedData's visible-bars bound independent from an intentionally
 // offscreen saved view; the exact saved view is installed after calculation.
 metadata.input.visibleBars=Math.min(RESOURCE_LIMITS.maxBars,metadata.input.visibleBars);return {metadata,doc,document:safeCheckpointStringify(doc),size:m.size,plan,dataIngestion};
}
function nativeWorkspaceTargetPlan(text){return nativeTargetSpec(text).plan;}
class NativeWorkspacePrepared extends PreparedData {
 constructor(text){const spec=nativeTargetSpec(text);super(safeCheckpointStringify(spec.metadata));this.workspace=spec.doc;this.workspaceIngestion=spec.dataIngestion;this.workspaceText=spec.document;this.normalizedWorkspace=nativeTargetNormalized(spec.doc);this.workspaceSize=Object.freeze({...spec.size});this.plan=spec.plan;this.checkpointBudget=new NativeCheckpointBudget();this.closed=false;this.transferred=false;this.workspaceEntries=[];this.workspaceEntryMap=null;this.workspaceColumnRefs=[];this.checkEntry=0;this.checkIterator=null;this.checked=0;this.expectedCheckpoints=(this.length===0?0:Math.floor(this.length/256)+1)*this.workspace.indicators.length;if(!nativeTargetEqual(this.metadata.indicators,this.workspace.indicators)){this.dispose();throw new TypeError('Native workspace factory changed metadata');}}
 assertActive(){if(this.closed||this.transferred)throw new Error('Native workspace target closed');}
 target(slot,offset,count){this.assertActive();try{return super.target(slot,offset,count);}catch(error){this.dispose();throw error;}}
 start(){this.assertActive();try{return super.start();}catch(error){this.dispose();throw error;}}
 initialize(){
  this.assertActive();if(this.length&&(this.columns.time[0]!==this.workspace.source.firstTime||this.columns.time[this.length-1]!==this.workspace.source.lastTime))throw new TypeError('Native workspace target source extent');
  const m=this.metadata;this.model=new ChartModel({store:this.store,panels:m.panels,axes:m.axes,theme:m.theme,precision:m.precision,axisWidth:m.axisWidth,visibleBars:this.input.visibleBars});this.model.indicators.maxOutputBytes=m.maxOutputBytes;this.model.indicators.entries=new NativeCheckpointEntries();this.workspaceEntryMap=this.model.indicators.entries;this.workspaceColumnRefs=FIELDS.map(k=>this.columns[k]);
  for(const study of this.workspace.indicators){const factory=resolveIndicatorFactory(study.name);requirePortableFactory(study.name,factory);const params={...study.params},def=factory(params),layout=workspaceSnapshot({outputs:def.outputs,plotOffsets:def.plotOffsets??{}});this.assertActive();if(!nativeTargetEqual(params,study.params)||!nativeTargetEqual(layout,{outputs:study.outputs,plotOffsets:study.plotOffsets}))throw new TypeError('Native workspace target factory binding');const checkpoints=new NativeCheckpointMap(study.name,study.params,{budget:this.checkpointBudget}),entry={def,name:study.name,params:{...study.params},dirty:0,dirtyTo:this.length,invalidated:true,length:0,arrays:[],checkpoints,revision:0};this.model.indicators.entries.set(study.id,entry);this.workspaceEntries.push([study.id,entry,factory]);}
  this.guardTarget();
 }
 guardTarget(metadata=true){this.assertActive();if(!this.model)return;if(this.model.disposed||this.model.store!==this.store||this.store.columns!==this.columns||this.store.version!==this.metadata.version||this.store.timeVersion!==this.metadata.timeVersion||this.store.length!==this.length||this.store.capacity!==this.capacity||this.model.indicators.entries!==this.workspaceEntryMap||this.model.indicators.entries.size!==this.workspaceEntries.length)throw new Error('Native workspace target changed');for(let i=0;i<this.workspaceEntries.length;i++){const [id,entry,factory]=this.workspaceEntries[i],study=this.workspace.indicators[i];if(this.model.indicators.entries.get(id)!==entry||this.model.indicators.registry.get(study.name)!==factory||!nativeTargetEqual(entry.params,study.params))throw new Error('Native workspace target entry changed');if(metadata){const layout=workspaceSnapshot({outputs:entry.def.outputs,plotOffsets:entry.def.plotOffsets??{}});if(!nativeTargetEqual(layout,{outputs:study.outputs,plotOffsets:study.plotOffsets}))throw new Error('Native workspace target output binding');}}this.assertActive();if(this.model.disposed||this.model.store!==this.store||this.store.version!==this.metadata.version||this.store.timeVersion!==this.metadata.timeVersion||this.store.columns!==this.columns||this.store.length!==this.length||this.store.capacity!==this.capacity||this.model.indicators.entries!==this.workspaceEntryMap||this.workspaceEntries.some(([id,e])=>this.workspaceEntryMap.get(id)!==e)||FIELDS.some((k,i)=>this.columns[k]!==this.workspaceColumnRefs[i]))throw new Error('Native workspace target changed');}
 step(maxBars=4096){this.assertActive();try{if(!Number.isInteger(maxBars)||maxBars<1||maxBars>65536)throw new RangeError('Prepare step size');if(this.phase==='workspace-ready'){this.guardReady();return {phase:this.phase,done:1,total:1,complete:true};}this.guardTarget();if(this.phase==='workspace-checkpoints')return this.checkpointStep(maxBars);const progress=super.step(maxBars);this.guardTarget();if(progress.complete){this.phase='workspace-checkpoints';return {phase:this.phase,done:0,total:this.expectedCheckpoints,complete:false};}return progress;}catch(error){this.dispose();throw error;}}
 checkpointStep(maxBars){let work=0;const limit=Math.max(1,Math.floor(maxBars/256)),perEntry=this.length===0?0:Math.floor(this.length/256)+1;
  while(this.checkEntry<this.workspaceEntries.length&&work<limit){const entry=this.workspaceEntries[this.checkEntry][1];if(!this.checkIterator){if(entry.checkpoints.size!==perEntry)throw new TypeError('Native workspace checkpoint count');this.checkIterator=entry.checkpoints.keys();this.checkOrdinal=0;}const next=this.checkIterator.next();if(next.done){if(this.checkOrdinal!==perEntry)throw new TypeError('Native workspace checkpoint count');this.checkIterator=null;this.checkEntry++;continue;}if(next.value!==this.checkOrdinal++*256)throw new TypeError('Native workspace checkpoint boundary');this.checked++;work++;}
  if(this.checkEntry<this.workspaceEntries.length)return {phase:this.phase,done:this.checked,total:this.expectedCheckpoints,complete:false};
  // PreparedData already installed series and their indexes. Apply only the
  // remaining validated workspace configuration without duplicating the series.
  installWorkspaceConfiguration(this.model,{...this.workspace,series:[]});this.guardTarget();if(this.workspaceIngestion!==null)this.model.dataIngestion=restoreDataIngestion(this.model,this.workspaceIngestion);this.readyBinding=this.readySnapshot();const saved=readWorkspaceDocument(saveWorkspace(new ChartAPI(this.model),this.workspace.dataset));if(!nativeTargetEqual(saved,this.normalizedWorkspace))throw new TypeError('Native workspace canonical restore mismatch');this.guardReady();this.phase='workspace-ready';return {phase:this.phase,done:1,total:1,complete:true};
 }
 readySnapshot(){const m=this.model;return {dataIngestion:m.dataIngestion,ingestionEpoch:m.dataIngestion?.epoch,panels:[...m.panels],axes:[...m.axes],series:[...m.series],seriesValues:m.series.map(e=>e.values),theme:m.theme,symbol:m.symbol,priceFormatter:m.priceFormatter,timeFormatter:m.timeFormatter,precision:m.precision,axisWidth:m.axisWidth,view:m.view,from:m.view.from,to:m.view.to,follow:m.follow,drawings:m.drawings,items:m.drawings.items,selected:m.drawings.selected,serial:m.drawings.serial};}
 guardReady(){this.guardTarget(false);const a=this.readyBinding,b=this.readySnapshot();if(!a||Object.keys(a).some(k=>['panels','axes','series','seriesValues'].includes(k)?a[k].length!==b[k].length||a[k].some((v,i)=>v!==b[k][i]):!Object.is(a[k],b[k]))||this.model.drawings.transaction||this.model.drawings.undoStack.length||this.model.drawings.redoStack.length)throw new Error('Native workspace target configuration changed');}
 finish(){this.assertActive();try{if(arguments.length||this.phase!=='workspace-ready')throw new Error('Native workspace target not ready');this.guardReady();const result={model:this.model,size:{...this.workspaceSize},plan:this.plan};this.transferred=true;this.model=null;this.columns={};this.store=null;this.task=null;this.workspace=null;this.workspaceIngestion=null;this.normalizedWorkspace=null;this.workspaceText=null;this.workspaceEntries=[];this.workspaceEntryMap=null;this.workspaceColumnRefs=[];this.checkIterator=null;this.readyBinding=null;return result;}catch(error){this.dispose();throw error;}}
 finishUI(){this.dispose();throw new Error('Native workspace target does not import source UI');}
 dispose(){if(this.closed)return;this.closed=true;try{if(!this.transferred){try{super.dispose();}finally{if(this.workspaceEntryMap)NativeCheckpointEntries.prototype.clear.call(this.workspaceEntryMap);}}}finally{this.model=null;this.columns={};this.store=null;this.task=null;this.workspace=null;this.workspaceIngestion=null;this.normalizedWorkspace=null;this.workspaceText=null;this.workspaceEntries=[];this.workspaceEntryMap=null;this.workspaceColumnRefs=[];this.checkIterator=null;this.readyBinding=null;}}
}

// Source admission/copy protocol only. Host context publication is separate.
const sourceTyped=Object.getPrototypeOf(Float64Array.prototype),sourceLength=Object.getOwnPropertyDescriptor(sourceTyped,'length').get,sourceBuffer=Object.getOwnPropertyDescriptor(sourceTyped,'buffer').get,sourceOffset=Object.getOwnPropertyDescriptor(sourceTyped,'byteOffset').get,sourceTag=Object.getOwnPropertyDescriptor(sourceTyped,Symbol.toStringTag).get,sourceBufferBytes=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get,sourceMapSize=Object.getOwnPropertyDescriptor(Map.prototype,'size').get,sourceEncodedBytes=Object.getOwnPropertyDescriptor(NativeCheckpointMap.prototype,'encodedBytes').get,sourceEncodedSize=Object.getOwnPropertyDescriptor(NativeCheckpointMap.prototype,'size').get;
function sourceInteger(n,max,label){if(!Number.isSafeInteger(n)||n<0||n>max)throw new RangeError('Workspace source '+label);return n;}
function sourceStale(){const e=new Error('Workspace source stale: owner/data/configuration changed');e.name='StaleSourceError';throw e;}
const sourceSlot=(o,k)=>workspaceSlot(o,k);
function sourceMapCount(map){return map instanceof NativeCheckpointMap?sourceEncodedSize.call(map):sourceMapSize.call(map);}
function sourceRefs(api,input,size){
 const m=sourceSlot(api,'model'),s=sourceSlot(m,'store'),d=sourceSlot(m,'drawings'),engine=sourceSlot(m,'indicators'),entries=sourceSlot(engine,'entries'),columns=sourceSlot(s,'columns'),out=[api,sourceSlot(api,'controller'),m,input,size,s,columns,sourceSlot(s,'version'),sourceSlot(s,'timeVersion'),sourceSlot(s,'length'),sourceSlot(s,'capacity'),s.maxBars,s.timeframeMs,s.timeOrigin,m.disposed,engine,entries,sourceMapSize.call(entries),m.dataIngestion,m.theme,m.symbol,m.priceFormatter,m.timeFormatter,m.precision,m.axisWidth,m.view,m.view.from,m.view.to,m.follow,m.crosshair,d,d.items,d.selected,d.serial,d.transaction,d.undoStack,d.redoStack,d.undoStack.length,d.redoStack.length,size.width,size.height];
 for(const list of [m.panels,m.axes,m.series,d.undoStack,d.redoStack]){out.push(list,list.length);for(const item of list)out.push(item);}
 for(const k of FIELDS){const a=sourceSlot(columns,k);out.push(a,sourceLength.call(a),sourceBuffer.call(a));}
 const tree=s.index;out.push(tree,tree?.min,tree?.max,tree?.sum);
 for(const [id,e] of Map.prototype.entries.call(entries)){const cp=sourceSlot(e,'checkpoints');out.push(id,e,e.def,e.name,e.params,e.revision,e.length,e.dirty,e.dirtyTo,e.invalidated,cp,sourceMapCount(cp),Map.prototype.get.call(engine.registry,e.name),e.arrays,e.arrays.length);for(const a of e.arrays)out.push(a);}
 for(const item of m.series){const index=item.rangeIndex,tree=index instanceof BlockRangeIndex?index.tree:index;out.push(item.values,item.revision,item.dirtyFrom,index,index?.values,tree,tree?.min,tree?.max,tree?.sum);}
 const session=m.dataIngestion;if(session){const policy=sourceSlot(session,'policy'),counters=sourceSlot(session,'counters');out.push(session,policy,counters,session.paused,session.closed,session.count,session.head,session.capacity,session.nextSequence,session.firstPendingSequence,session.lastError,session.columns,session.kinds);for(const k of Object.keys(policy))out.push(k,sourceSlot(policy,k));for(const k of Object.keys(counters))out.push(k,sourceSlot(counters,k));for(const k of FIELDS)out.push(sourceSlot(session.columns,k));}
 if(input)out.push(sourceSlot(input,'model'),input.tool,input.text,input.drawingTarget,input.gesture,input.pointers,input.pointers?.size);
 return out;
}
function sourceSame(a,b){return a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));}
class NativeWorkspaceCapture {
 constructor(api,text,binding,{input=null,size,revision,maxBytes=NATIVE_WORKSPACE_RESTORE_BYTES}={}){
  if(!(api instanceof ChartAPI)||!(sourceSlot(api,'model') instanceof ChartModel))throw new TypeError('Workspace source actual API/model required');const model=sourceSlot(api,'model');if(model.disposed)throw new Error('Chart disposed');if(sourceSlot(api,'controller')!==input||input&&sourceSlot(input,'model')!==model)throw new TypeError('Workspace source controller binding');if(!(sourceSlot(model,'store') instanceof BarStore))throw new TypeError('Workspace source actual BarStore required');if(input?.gesture||input?.pointers?.size||model.drawings.transaction)throw new Error('Workspace source active gesture');sourceInteger(revision,Number.MAX_SAFE_INTEGER,'host revision');sourceInteger(maxBytes,NATIVE_WORKSPACE_RESTORE_BYTES,'byte limit');if(!maxBytes)throw new RangeError('Workspace source byte limit');if(!size||!Number.isFinite(size.width)||!Number.isFinite(size.height))throw new TypeError('Workspace source size');assertDataIngestionIdle(model);
  this.api=api;this.model=model;this.input=input;this.size=size;this.hostRevision=revision;this.maxBytes=maxBytes;this.closed=false;this.phase='admission';this.records=[];this.frames=[];this.recordAt=0;this.recordIterator=null;this.frameAt=0;this.drawingAt=0;this.seenDrawings=new WeakSet();this.seenFrames=new WeakSet();this.buffers=[];this.offsets=FIELDS.map(()=>0);this.sourceBytes=0;this.checkpointBytes=0;this.drawingBytes=0;this.recordCount=0;this.drawingCount=0;this.lease=null;
  try{
   this.before=sourceRefs(api,input,size);this.lease=acquireDataIngestionLease(model);this.session=model.dataIngestion;this.leaseEpoch=this.session?.epoch;this.refs=sourceRefs(api,input,size);if(!sourceSame(this.before,this.refs))sourceStale();this.before=null;
   this.ingestionText=this.session?DataIngestion.prototype.save.call(this.session):null;this.binding=workspaceBinding(binding);this.document=readWorkspaceDocument(text);nativeWorkspacePreflight(api,text,this.binding);this.check(revision);
   const store=model.store,seenBuffers=new Set(),put=a=>{if(!['Float64Array','Uint8Array'].includes(sourceTag.call(a)))throw new TypeError('Workspace source numeric buffer');const buffer=sourceBuffer.call(a),bytes=sourceBufferBytes.call(buffer);if(!seenBuffers.has(buffer)){seenBuffers.add(buffer);this.charge(bytes,'sourceBytes');}};
   this.buffers=FIELDS.map(k=>sourceSlot(store.columns,k));for(const a of this.buffers){if(sourceTag.call(a)!=='Float64Array'||sourceLength.call(a)<store.length)throw new TypeError('Workspace source column length');put(a);}const tree=t=>{if(!t)return;for(const k of ['min','max','sum'])if(t[k])put(t[k]);};tree(store.index);if(this.session){for(const k of FIELDS)put(sourceSlot(this.session.columns,k));put(this.session.kinds);}
   for(const [,e] of Map.prototype.entries.call(model.indicators.entries)){for(const a of e.arrays)put(a);const map=sourceSlot(e,'checkpoints');if(map instanceof NativeCheckpointMap)this.charge(sourceEncodedBytes.call(map)+sourceEncodedSize.call(map)*128,'checkpointBytes');else{const count=sourceMapSize.call(map);sourceInteger(count,4194305,'checkpoint count');this.charge(count*128,'checkpointBytes');this.records.push(map);}}
   for(const item of model.series){if(item.values)put(item.values);const index=item.rangeIndex;if(index?.values)put(index.values);tree(index instanceof BlockRangeIndex?index.tree:index);}
   const d=model.drawings;this.frames=[d.items,...d.undoStack,...d.redoStack];sourceInteger(this.frames.length,20001,'drawing frame count');for(const frame of this.frames){if(!Array.isArray(frame)||frame.length>10000)throw new TypeError('Workspace source drawing frame');if(!this.seenFrames.has(frame)){this.seenFrames.add(frame);this.charge(frame.length*8,'drawingBytes');}}
   this.check(revision);
  }catch(error){this.dispose();throw error;}
 }
 charge(bytes,key){sourceInteger(bytes,this.maxBytes,'logical bytes');if(this.sourceBytes+this.checkpointBytes+this.drawingBytes>this.maxBytes-bytes)throw new RangeError('Workspace source logical byte limit');this[key]+=bytes;}
 active(){if(this.closed)throw new Error('Workspace source capture closed');}
 check(revision){this.active();if(revision!==this.hostRevision||!sourceSame(this.refs,sourceRefs(this.api,this.input,this.size))||this.session!==this.model.dataIngestion||this.session&&(this.session.epoch!==this.leaseEpoch||this.session.closed||!this.session.leased))sourceStale();return true;}
 step(maxRecords=8,revision){this.active();try{sourceInteger(maxRecords,64,'admission work');if(!maxRecords)throw new RangeError('Workspace source admission work');this.check(revision);if(this.phase!=='admission')return {phase:this.phase,complete:true};let work=0;
  while(this.recordAt<this.records.length&&work<maxRecords){if(!this.recordIterator)this.recordIterator=Map.prototype.values.call(this.records[this.recordAt]);const row=this.recordIterator.next();if(row.done){this.recordAt++;this.recordIterator=null;continue;}const cost=nativeCheckpointFootprint(row.value);this.charge(cost.logicalBytes,'checkpointBytes');this.recordCount++;work++;this.check(revision);}
  while(this.recordAt===this.records.length&&this.frameAt<this.frames.length&&work<maxRecords){const frame=this.frames[this.frameAt];if(this.drawingAt===frame.length){this.frameAt++;this.drawingAt=0;continue;}const drawing=frame[this.drawingAt++];work++;if(!drawing||typeof drawing!=='object')throw new TypeError('Workspace source drawing');if(!this.seenDrawings.has(drawing)){this.seenDrawings.add(drawing);this.charge(nativeCheckpointFootprint(drawing).logicalBytes,'drawingBytes');this.drawingCount++;}this.check(revision);}
  if(this.recordAt<this.records.length||this.frameAt<this.frames.length)return {phase:'admission',done:this.recordCount+this.drawingCount,complete:false};
  const s=this.model.store;this.metadataJSON=safeCheckpointStringify({schema:'aster.native-workspace-target',version:1,...(this.ingestionText===null?{}:{dataIngestion:this.ingestionText}),document:safeCheckpointStringify(this.document),datasetBinding:this.binding,source:{length:s.length,maxBars:s.maxBars,timeframeMs:s.timeframeMs,timeOrigin:s.timeOrigin,version:s.version,timeVersion:s.timeVersion},size:{width:this.size.width,height:this.size.height},retainedBytes:this.sourceBytes+this.checkpointBytes+this.drawingBytes,maxBytes:this.maxBytes});this.plan=nativeWorkspaceTargetPlan(this.metadataJSON);this.check(revision);this.phase='copy';return {phase:'copy',done:this.recordCount+this.drawingCount,complete:true};
 }catch(error){this.dispose();throw error;}}
 buffer(slot,offset,count,revision){this.active();try{this.check(revision);if(this.phase!=='copy'||!Number.isInteger(slot)||slot<0||slot>=6||offset!==this.offsets[slot]||!Number.isSafeInteger(count)||count<1||count>262144||offset+count>this.model.store.length)throw new RangeError('Workspace source copy slice');const a=this.buffers[slot],view=new Float64Array(sourceBuffer.call(a),sourceOffset.call(a)+offset*8,count);this.offsets[slot]+=count;this.check(revision);return view;}catch(error){this.dispose();throw error;}}
 finish(revision){this.active();try{this.check(revision);if(this.phase!=='copy'||this.offsets.some(n=>n!==this.model.store.length))throw new Error('Workspace source copy incomplete');const session=this.session,epoch=this.leaseEpoch,release=this.lease;this.lease=null;release?.();if(session&&(session!==this.model.dataIngestion||session.epoch!==epoch+1||session.closed||session.leased))sourceStale();if(revision!==this.hostRevision||!sourceSame(this.refs,sourceRefs(this.api,this.input,this.size)))sourceStale();assertDataIngestionIdle(this.model);const receipt={schema:'aster.native-workspace-source-finished',version:1,revision:this.hostRevision,sourceVersion:this.model.store.version,sourceBytes:this.sourceBytes,checkpointBytes:this.checkpointBytes,drawingBytes:this.drawingBytes};this.dispose();return receipt;}catch(error){this.dispose();throw error;}}
 dispose(){if(this.closed)return;this.closed=true;try{const release=this.lease;this.lease=null;release?.();}finally{this.api=null;this.model=null;this.input=null;this.size=null;this.session=null;this.refs=null;this.before=null;this.records=[];this.frames=[];this.recordIterator=null;this.buffers=[];this.document=null;this.ingestionText=null;this.binding=null;this.metadataJSON=null;this.seenDrawings=null;this.seenFrames=null;}}
}

const uiKeys=['limits','items','undo','redo','selected','serial'];
const uiLimitKeys=['historyLimit','maxDrawings','maxPoints','maxDocumentChars','historyBytes'];
const UI_CHUNK_CHARS=262144,UI_CHUNK_UTF8=1048576,UI_CHUNK_NODES=250000,UI_CHUNK_REFS=64,UI_CHUNK_POINTS=2048;
const uiOmit=value=>Array.isArray(value)?value.map(uiOmit):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,uiOmit(v)])):value;
function uiHeader(state){const d=state.drawings;return {schema:'aster.async.ui',protocol:1,state:uiOmit({...state,drawings:{limits:d.limits,frameCounts:[d.items.length,...d.undo.map(a=>a.length),...d.redo.map(a=>a.length)],undoCount:d.undo.length,redoCount:d.redo.length,selected:d.selected,serial:d.serial}})};}
// JavaScriptCore/QuickJS need no TextEncoder or host API. Count bytes of the
// already validated serialized JSON, including escaped controls and surrogates.
function uiUTF8Bytes(text){let bytes=0;for(let i=0;i<text.length;i++){const code=text.charCodeAt(i);if(code<=0x7f)bytes++;else if(code<=0x7ff)bytes+=2;else if(code>=0xd800&&code<=0xdbff){bytes+=4;i++;}else bytes+=3;}return bytes;}
function uiSerializedNodes(value){let nodes=0;const stack=[value];while(stack.length){const v=stack.pop();nodes++;if(typeof v==='number'&&(!Number.isFinite(v)||Object.is(v,-0)))nodes++;else if(v&&typeof v==='object')for(const item of Object.values(v))stack.push(item);}return nodes;}
function uiBoundedString(value){const text=safeCheckpointStringify(value);if(text.length>UI_CHUNK_CHARS||uiUTF8Bytes(text)>UI_CHUNK_UTF8)throw new RangeError('Async UI chunk text limit');return text;}
function uiDrawingRecord(drawing){const text=safeCheckpointStringify(drawing);return {drawing,text,bytes:uiUTF8Bytes(text),nodes:uiSerializedNodes(drawing),points:drawing.points.length};}
function uiRefsEqual(a,b){return a.length===b.length&&a.every((v,i)=>v===b[i]);}
class AsyncUICapture {
 constructor(capture,input,size){this.capture=capture;const state=capture.uiState(input,size),d=state.drawings;optionRecord(d,uiKeys,'Async drawing state');this.headerJSON=uiBoundedString(uiHeader(state));this.current=d.items.slice();this.undo=d.undo.slice();this.redo=d.redo.slice();this.frames=[this.current,...this.undo,...this.redo];this.frame=0;this.offset=0;this.slots=new Map();this.lastComplete=false;this.deferred=null;}
 check(input,size){const state=this.capture.uiState(input,size),d=state.drawings;if(uiBoundedString(uiHeader(state))!==this.headerJSON||!uiRefsEqual(this.current,d.items)||!uiRefsEqual(this.undo,d.undo)||!uiRefsEqual(this.redo,d.redo))throw new Error('Async stale: UI changed during transfer');return true;}
 next(){this.capture.check();let frame=this.frame,offset=this.offset;while(frame<this.frames.length&&offset===this.frames[frame].length){frame++;offset=0;}if(frame===this.frames.length){this.frame=frame;this.offset=offset;this.lastComplete=true;this.deferred=null;return '{"complete":true}';}
  const refs=[],records=[],pending=new Map(),items=this.frames[frame],prefix=`{"complete":false,"frame":${frame},"offset":${offset},"refs":[`,middle='],"records":[',suffix=']}',base=prefix.length+middle.length+suffix.length;
  let at=offset,chars=base,bytes=base,nodes=6,points=0,deferred=this.deferred;
  while(at<items.length&&refs.length<UI_CHUNK_REFS){const drawing=items[at],known=this.slots.get(drawing)??pending.get(drawing);let slot=known,record=null;
   if(slot===undefined){slot=this.slots.size+pending.size;record=deferred?.drawing===drawing?deferred:uiDrawingRecord(drawing);}
   const ref=String(slot),row=record?`{"slot":${slot},"drawing":${record.text}}`:null,extraChars=ref.length+(refs.length?1:0)+(row?row.length+(records.length?1:0):0),extraBytes=extraChars+(record?record.bytes-record.text.length:0),extraNodes=1+(record?2+record.nodes:0),extraPoints=record?.points??0;
   if(chars+extraChars>UI_CHUNK_CHARS||bytes+extraBytes>UI_CHUNK_UTF8||nodes+extraNodes>UI_CHUNK_NODES||points+extraPoints>UI_CHUNK_POINTS){if(!refs.length)throw new RangeError('Async UI single record exceeds chunk budget');deferred=record;break;}
   refs.push(ref);if(record){pending.set(drawing,slot);records.push(row);deferred=null;}chars+=extraChars;bytes+=extraBytes;nodes+=extraNodes;points+=extraPoints;at++;
  }
  // Each new immutable drawing is serialized once. Only one deferred candidate
  // survives a boundary; history references reuse committed slots. No growing
  // candidate packet is repeatedly serialized, and rejected candidates cannot
  // advance the capture's committed offset or slot dictionary.
  const text=prefix+refs.join(',')+middle+records.join(',')+suffix;
  if(text.length!==chars||chars>UI_CHUNK_CHARS||bytes>UI_CHUNK_UTF8||nodes>UI_CHUNK_NODES)throw new RangeError('Async UI chunk budget mismatch');
  for(const [drawing,slot] of pending)this.slots.set(drawing,slot);this.frame=frame;this.offset=at;this.deferred=deferred;return text;
 }
}
class AsyncUIImport {
 constructor(text,prepared){const header=safeCheckpointParse(text);optionRecord(header,['schema','protocol','state'],'Async UI header');if(header.schema!=='aster.async.ui'||header.protocol!==1||!header.state||typeof header.state!=='object')throw new TypeError('Async UI protocol');this.state=header.state;this.prepared=prepared;const d=this.state.drawings;optionRecord(d,['limits','frameCounts','undoCount','redoCount','selected','serial'],'Async drawing header');optionRecord(d.limits,uiLimitKeys,'Async drawing limits');this.store=new DrawingStore(d.limits);sizeLimit(d.undoCount,this.store.historyLimit,'Async undo count');sizeLimit(d.redoCount,this.store.historyLimit,'Async redo count');sizeLimit(d.serial,Number.MAX_SAFE_INTEGER,'Async drawing serial');if(!Array.isArray(d.frameCounts)||d.frameCounts.length!==1+d.undoCount+d.redoCount)throw new TypeError('Async UI frame counts');let references=0;for(const n of d.frameCounts){sizeLimit(n,this.store.maxDrawings,'Async UI frame size');references+=n;}if(references>this.store.maxDrawings+Math.floor(this.store.historyBytes/8))throw new RangeError('Async UI history reference budget');this.counts=d.frameCounts;this.frames=this.counts.map(()=>[]);this.records=[];this.used=new Set();this.frame=0;this.offset=0;this.finished=false;this.newPoints=0;this.newText=0;}
 skipEmpty(){while(this.frame<this.counts.length&&this.offset===this.counts[this.frame]){const frame=this.frames[this.frame];this.store.budget(frame);if(new Set(frame.map(d=>d.id)).size!==frame.length)throw new TypeError('Async duplicate drawing ids');this.store.weight(frame);this.frame++;this.offset=0;}}
 chunk(text){if(this.finished)throw new Error('Async UI import finished');if(typeof text!=='string'||text.length>262144)throw new RangeError('Async UI chunk text');const p=safeCheckpointParse(text);optionRecord(p,['complete','frame','offset','refs','records'],'Async UI chunk');this.skipEmpty();if(p.complete!==false||p.frame!==this.frame||p.offset!==this.offset||!Array.isArray(p.refs)||!p.refs.length||p.refs.length>64||!Array.isArray(p.records)||p.records.length>64||this.frame>=this.counts.length||this.offset+p.refs.length>this.counts[this.frame])throw new TypeError('Async UI chunk order/offset');
  let points=0;for(const row of p.records){optionRecord(row,['slot','drawing'],'Async UI record');if(row.slot!==this.records.length)throw new TypeError('Async UI record slot');const temp=new DrawingStore({...this.state.drawings.limits,maxDocumentChars:RESOURCE_LIMITS.maxDocumentChars}),bindingModel=Object.create(this.prepared.model);Object.assign(bindingModel,{panels:this.state.panels,axes:this.state.axes??[],series:this.state.series});temp.load(JSON.stringify({schema:'aster.drawings',version:row.drawing.axisId!=null||row.drawing.seriesId!=null?2:1,drawings:[row.drawing]}),{styleDecoder:s=>portableStyle(s,['color','fill'],true),validatePanel:id=>Array.isArray(this.state.panels)&&this.state.panels.some(p=>p.id===id),validateBinding:d=>bindingModel.validateDrawingBinding(d,{allowOrphanSeries:true})});const drawing=temp.items[0];points+=drawing.points.length;this.newPoints+=drawing.points.length;this.newText+=JSON.stringify(drawing).length;if(points>2048||this.newPoints>this.store.maxPoints+Math.floor(this.store.historyBytes/32)||this.newText>this.store.maxPoints*96+this.store.maxDrawings*3072+Math.floor(this.store.historyBytes/2))throw new RangeError('Async UI unique record budget');this.records.push(drawing);}
  const added=p.refs.map(slot=>{sizeLimit(slot,this.records.length-1,'Async UI reference slot');const drawing=this.records[slot];if(!drawing)throw new TypeError('Async UI reference slot');this.used.add(slot);return drawing;});this.frames[this.frame].push(...added);this.offset+=added.length;
 }
 finish(){if(this.finished)throw new Error('Async UI import finished');this.skipEmpty();if(this.frame!==this.frames.length)throw new Error('Async UI incomplete transfer');if(this.used.size!==this.records.length)throw new TypeError('Async UI unused record');const d=this.state.drawings;this.store.items=this.frames[0];this.store.undoStack=this.frames.slice(1,1+d.undoCount);this.store.redoStack=this.frames.slice(1+d.undoCount);this.store.selected=d.selected;this.store.serial=d.serial;const state={...this.state,drawings:{limits:d.limits,items:this.store.items,undo:this.store.undoStack,redo:this.store.redoStack,selected:d.selected,serial:d.serial}};const result=this.prepared.finishUI(state,this.store);this.finished=true;return result;}
}

// Private native display transport. Source OHLCV/indicator arrays are never
// converted or transferred here; these are renderer-neutral CSS coordinates.
const nativePacketLimits={numbers:8388608,metadataBytes:1048576,commands:65536,strings:65536};
const nativePacketOps={lines:1,rects:2,path:3,box:4,ellipse:5,text:6};
function nativePacketFinite(value,label){if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('Native packet finite '+label);return value;}
function nativePacketArray(value,label){if(!Array.isArray(value)&&!(value instanceof Float64Array))throw new TypeError('Native packet '+label+' array');return value;}
function nativePacketUTF8Bytes(text){let bytes=0;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c<128)bytes++;else if(c<2048)bytes+=2;else if(c>=0xd800&&c<=0xdbff&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else bytes+=3;}return bytes;}

/** Internal wire v1: 15 F64 header values, then dash and ordered geometry.
 * Private limits trigger an explicit caller-owned legacy fallback. They never
 * truncate commands, source history, coordinates or strings.
 */
function packNativeCommands(layers,{mode,width,height,background,stats}){
 if(!['scene','frame'].includes(mode)||!Array.isArray(layers)||layers.length!==(mode==='scene'?1:3)||layers.at(-1)===null)throw new TypeError('Native packet mode/layers');
 nativePacketFinite(width,'width');nativePacketFinite(height,'height');
 if(typeof background!=='string')throw new TypeError('Native packet background string');
 const strings=[],dictionary=new Map(),records=[],layerMetadata=[];let total=0,commandCount=0,stringBytes=0;
 const string=value=>{
  if(typeof value!=='string')throw new TypeError('Native packet string');
  if(dictionary.has(value))return dictionary.get(value);
  if(strings.length>=nativePacketLimits.strings)throw new RangeError('Native packet string limit');
  stringBytes+=nativePacketUTF8Bytes(value);if(stringBytes>nativePacketLimits.metadataBytes)throw new RangeError('Native packet metadata byte limit');
  const index=strings.length;dictionary.set(value,index);strings.push(value);return index;
 };
 for(const layer of layers){
  if(layer===null){layerMetadata.push(null);continue;}
  if(!layer||!Array.isArray(layer.commands))throw new TypeError('Native packet commands array');
  commandCount+=layer.commands.length;if(commandCount>nativePacketLimits.commands)throw new RangeError('Native packet command limit');
  layerMetadata.push({commands:layer.commands.length});
  for(const c of layer.commands){
   const op=nativePacketOps[c?.op];if(!Object.hasOwn(nativePacketOps,c?.op))throw new TypeError('Native packet unsupported operation');
   const color=string(c.color),stroke=nativePacketFinite(c.width??1,'stroke');if(stroke<0)throw new RangeError('Native packet stroke');
   const clip=c.clip==null?null:nativePacketArray(c.clip,'clip');if(clip&&clip.length!==4)throw new TypeError('Native packet clip arity');
   const clipValues=clip?Array.from(clip,v=>nativePacketFinite(v,'clip')):[0,0,0,0];
   const dash=c.dash==null?[]:nativePacketArray(c.dash,'dash');if(c.dash!=null&&(!dash.length||dash.length%2))throw new TypeError('Native packet dash arity');
   const fill=c.fill==null?-1:string(c.fill),baseline=op===3&&fill!==-1?nativePacketFinite(c.baseline,'area baseline'):0;
   const text=op===6?string(c.text):-1,font=op===6?string(c.font??'12px monospace'):-1;
   const geometry=op<=2?nativePacketArray(c.coords,'coords'):op===3?nativePacketArray(c.points,'points'):op<=5?[c.x,c.y,c.w,c.h]:[c.x,c.y];
   if(op<=2&&geometry.length%4||op===3&&geometry.length%2)throw new TypeError('Native packet geometry arity');
   const recordLength=15+dash.length+geometry.length;
   if(!Number.isSafeInteger(recordLength)||total+recordLength>nativePacketLimits.numbers)throw new RangeError('Native packet number limit');
   total+=recordLength;
   records.push({header:[op,recordLength,color,stroke,clip?1:0,...clipValues,dash.length,fill,baseline,text,font,geometry.length],dash,geometry});
  }
 }
 const metadata=JSON.stringify({schema:'aster.native.commands',version:1,mode,width,height,background,stats,strings,layers:layerMetadata});
 if(nativePacketUTF8Bytes(metadata)>nativePacketLimits.metadataBytes)throw new RangeError('Native packet metadata byte limit');
 const numbers=new Float64Array(total);let cursor=0;
 for(const {header,dash,geometry} of records){
  numbers.set(header,cursor);cursor+=15;
  for(const value of dash){nativePacketFinite(value,'dash');if(value<=0)throw new RangeError('Native packet positive dash');numbers[cursor++]=value;}
  for(const value of geometry)numbers[cursor++]=nativePacketFinite(value,'geometry');
 }
 if(cursor!==total)throw new TypeError('Native packet geometry changed during encoding');
 return {metadata,numbers};
}

globalThis.Aster={RESOURCE_LIMITS,optionRecord,boundedText,sizeLimit,identifier,PANEL_KEYS,AXIS_KEYS,SERIES_KEYS,THEME_KEYS,rememberSymbolFormatters,hasPortableFormatters,portableColor,portableFont,portableStyle,labelMetrics,labelWidth,fitLabel,labelCommand,panelTitle,FIELDS,validateBar,RangeIndex,BarStore,seededColumns,BlockRangeIndex,zonedParts,marketDate,shiftDate,zonedEpoch,validateSymbol,formatPrice,normalizeOHLCV,alignSeriesByTime,SessionCalendar,TickAggregator,applyDataEvent,DEMO_SYMBOLS,demoCalendar,validateResamplePlan,resamplePlanResolver,resampleOHLCV,resampleFromSessions,alignConfirmedByTime,validateIndicatorParams,UnsupportedIndicatorError,defineIndicatorModule,portableIndicatorFactory,portableIndicatorFactories,indicatorModule,requirePortableIndicator,indicatorModuleDefinitions,validateIndicatorModuleBinding,validateModuleCheckpoint,portableSessionCalendar,vwapDefinition,pivotsDefinition,validateSessionCheckpoint,builtinIndicators,isCanonicalBuiltinDefinition,resolveIndicatorFactory,requirePortableFactory,IndicatorEngine,DRAWING_TYPES,drawingPointCount,validateDrawing,DrawingStore,drawingGeometry,drawingHitTest,formatAxisValue,aggregateVolumeSeries,createDrawingCommands,createCrosshairCommands,crosshairValuesAt,SERIES_BLOCK_THRESHOLD,DARK_THEME,LIGHT_THEME,ChartModel,createLayout,buildScene,SceneCache,InteractionController,safeCheckpointStringify,safeCheckpointParse,validateCheckpointState,NATIVE_CHECKPOINT_RECORD_BYTES,nativeCheckpointFootprint,NativeCheckpointBudget,NativeCheckpointMap,NativeCheckpointEntries,IngestionError,assertDataIngestionIdle,acquireDataIngestionLease,dataIngestionBatchLimits,snapshotIngestionEvents,DataIngestion,restoreDataIngestion,saveStudySetup,setStudyParams,loadStudySetup,dataAt,ChartAPI,WORKSPACE_CHARS,workspaceSlot,workspaceSnapshot,workspaceBinding,workspaceBindingSame,validateWorkspaceDocument,readWorkspaceDocument,saveWorkspace,installWorkspaceConfiguration,nativeWorkspacePreflight,asyncConfigurationKey,AsyncCapture,AsyncPrepared,PrepareCapture,PreparedData,NATIVE_WORKSPACE_RESTORE_BYTES,nativeWorkspaceTargetPlan,NativeWorkspacePrepared,NativeWorkspaceCapture,AsyncUICapture,AsyncUIImport};
let nativeLatestLayout=null,nativeLatestLayoutModel=null;
let nativeWorkspaceSource=null,nativeWorkspaceRegistration=0;
let nativeAsyncCapture=null,nativeAsyncTicket=0,nativeAsyncPrepared=null,nativeAsyncUIImport=null,nativeAsyncUIPrepared=null;
function nativeCapture(ticket){if(!nativeAsyncCapture||nativeAsyncCapture.ticket!==ticket||nativeAsyncCapture.capture.model!==globalThis.nativeModel)throw new Error('Async stale: source replaced/released');nativeAsyncCapture.capture.check();return nativeAsyncCapture.capture;}
globalThis.nativeAsyncBegin=function(eventJSON){if(nativeAsyncCapture||nativeWorkspaceSource)throw new Error('Async capture busy');const capture=new AsyncCapture(globalThis.nativeModel,JSON.parse(eventJSON)),ticket=++nativeAsyncTicket;nativeAsyncCapture={ticket,capture};return JSON.stringify({ticket,metadataJSON:capture.metadataJSON,buffers:capture.buffers.map((a,slot)=>({slot,length:a.length})),checkpoints:capture.checkpoints.map((row,entry)=>({entry,total:row.keys.length,maxRows:row.maxRows}))});};
globalThis.nativePrepareBegin=function(requestJSON){if(nativeAsyncCapture||nativeWorkspaceSource)throw new Error('Async capture busy');const capture=new PrepareCapture(globalThis.nativeModel,JSON.parse(requestJSON)),ticket=++nativeAsyncTicket;nativeAsyncCapture={ticket,capture};return JSON.stringify({ticket,metadataJSON:capture.metadataJSON,buffers:[],checkpoints:[]});};
globalThis.nativeDataAsyncBegin=function(kind,requestJSON){
 if(!['correction','columns','seeded'].includes(kind))throw new TypeError('Unknown async begin kind');
 try{return {result:kind==='correction'?nativeAsyncBegin(requestJSON):nativePrepareBegin(requestJSON)};}catch(error){if(!(error instanceof IngestionError))throw error;return {error:{name:error.name,code:error.code,message:String(error.message).slice(0,256)}};}
};
// A retained closed Swift engine deliberately retains its raw JSContext. Retire
// the opt-in ring without changing that legacy raw-data/context ownership rule.
globalThis.nativeReleaseDataIngestion=function(){const session=globalThis.nativeModel?.dataIngestion;const cancelled=session?.count??0;session?.dispose();return {cancelled,pendingEvents:0,ownedBytes:0};};
globalThis.nativePrepareCreate=function(metadataJSON){if(nativeAsyncPrepared)throw new Error('Async target busy');nativeAsyncPrepared=new PreparedData(metadataJSON);return true;};
// Internal target-only workspace protocol. Host source capture/publication is
// separate; reject use in an already initialized live runtime.
function nativeWorkspaceTargetVacant(){if(!Object.isExtensible(globalThis))throw new Error('Workspace target global is not extensible');for(const key of ['nativeModel','nativeAPI','nativeInput','nativeSize']){const d=Object.getOwnPropertyDescriptor(globalThis,key);if(d&&(!Object.hasOwn(d,'value')||d.value!==undefined||!d.configurable))throw new Error('Workspace target requires an isolated empty runtime');}}
globalThis.nativeWorkspaceTargetCreate=function(metadataJSON){if(nativeAsyncPrepared||nativeAsyncUIImport||nativeAsyncUIPrepared)throw new Error('Async target busy');nativeWorkspaceTargetVacant();const target=new NativeWorkspacePrepared(metadataJSON);try{nativeWorkspaceTargetVacant();nativeAsyncPrepared=target;return true;}catch(error){target.dispose();throw error;}};
globalThis.nativeWorkspaceTargetFinish=function(){if(!(nativeAsyncPrepared instanceof NativeWorkspacePrepared))throw new Error('Workspace target missing');const target=nativeAsyncPrepared;let result;try{nativeWorkspaceTargetVacant();result=target.finish();nativeWorkspaceTargetVacant();const input=new InteractionController(result.model,()=>globalThis.nativeSize),api=new ChartAPI(result.model,{controller:input});Object.defineProperties(globalThis,{nativeSize:{value:result.size,writable:true,configurable:true,enumerable:true},nativeModel:{value:result.model,writable:true,configurable:true,enumerable:true},nativeInput:{value:input,writable:true,configurable:true,enumerable:true},nativeAPI:{value:api,writable:true,configurable:true,enumerable:true}});nativeLatestLayout=null;nativeLatestLayoutModel=null;nativeAsyncPrepared=null;return {schema:'aster.native-workspace-target-ready',version:1,status:'target-ready',hostPublished:false,plan:result.plan};}catch(error){try{result?.model.dispose();}finally{try{target.dispose();}finally{if(nativeAsyncPrepared===target)nativeAsyncPrepared=null;}}throw error;}};
globalThis.nativeWorkspaceTargetDispose=function(){if(nativeAsyncPrepared instanceof NativeWorkspacePrepared){const target=nativeAsyncPrepared;try{target.dispose();}finally{if(nativeAsyncPrepared===target)nativeAsyncPrepared=null;}return true;}return false;};
function nativeWorkspaceSourceOwner(row){if(workspaceSlot(globalThis,'nativeModel')!==row.model||workspaceSlot(globalThis,'nativeAPI')!==row.api||workspaceSlot(globalThis,'nativeInput')!==row.input||workspaceSlot(globalThis,'nativeSize')!==row.size||workspaceSlot(row.api,'model')!==row.model||workspaceSlot(row.api,'controller')!==row.input||workspaceSlot(row.input,'model')!==row.model)throw new Error('Workspace source stale: native owner replaced');}
function nativeWorkspaceSourceRow(ticket){const row=nativeWorkspaceSource;if(!row||row.ticket!==ticket)throw new Error('Workspace source ticket missing/released');return row;}
function nativeWorkspaceSourceDrop(row){try{row.capture?.dispose();}finally{if(nativeWorkspaceSource===row)nativeWorkspaceSource=null;}}
function nativeWorkspaceSourceOperation(ticket,operation){const row=nativeWorkspaceSourceRow(ticket);try{nativeWorkspaceSourceOwner(row);const result=operation(row);nativeWorkspaceSourceOwner(row);return result;}catch(error){nativeWorkspaceSourceDrop(row);throw error;}}
globalThis.nativeWorkspaceSourceBegin=function(document,binding,revision,maxBytes=805306368,registration){if(nativeAsyncCapture||nativeWorkspaceSource)throw new Error('Async capture busy');if(registration!==undefined){if(!Number.isSafeInteger(registration)||registration<=nativeWorkspaceRegistration)throw new RangeError('Workspace registration must increase');nativeWorkspaceRegistration=registration;}if(!Number.isSafeInteger(nativeAsyncTicket+1))throw new RangeError('Workspace source ticket limit');const row={ticket:++nativeAsyncTicket,registration,model:workspaceSlot(globalThis,'nativeModel'),api:workspaceSlot(globalThis,'nativeAPI'),input:workspaceSlot(globalThis,'nativeInput'),size:workspaceSlot(globalThis,'nativeSize'),capture:null,revision};nativeWorkspaceSourceOwner(row);nativeWorkspaceSource=row;try{row.capture=new NativeWorkspaceCapture(row.api,document,binding,{input:row.input,size:row.size,revision,maxBytes});if(nativeWorkspaceSource!==row)throw new Error('Workspace source stale: registration changed');nativeWorkspaceSourceOwner(row);return {ticket:row.ticket,phase:'admission',...(registration===undefined?{}:{registration})};}catch(error){nativeWorkspaceSourceDrop(row);throw error;}};
globalThis.nativeWorkspaceSourceStep=function(ticket,maxRecords,revision){return nativeWorkspaceSourceOperation(ticket,row=>{const progress=row.capture.step(maxRecords,revision);return progress.complete?{...progress,ticket,metadataJSON:row.capture.metadataJSON,plan:row.capture.plan,buffers:FIELDS.map((_,slot)=>({slot,length:row.model.store.length})),checkpoints:[]}:progress;});};
globalThis.nativeWorkspaceSourceCheck=function(ticket,revision){return nativeWorkspaceSourceOperation(ticket,row=>row.capture.check(revision));};
globalThis.nativeWorkspaceSourceBuffer=function(ticket,slot,offset,count,revision){return nativeWorkspaceSourceOperation(ticket,row=>row.capture.buffer(slot,offset,count,revision));};
globalThis.nativeWorkspaceSourceFinish=function(ticket,revision){const row=nativeWorkspaceSourceRow(ticket);try{nativeWorkspaceSourceOwner(row);const receipt=row.capture.finish(revision);nativeWorkspaceSourceOwner(row);return {...receipt,ticket};}finally{nativeWorkspaceSourceDrop(row);}};
globalThis.nativeWorkspaceSourceDispose=function(ticket){if(!nativeWorkspaceSource||nativeWorkspaceSource.ticket!==ticket)return false;nativeWorkspaceSourceDrop(nativeWorkspaceSource);return true;};
// Host-known correlation identity survives lost Begin responses; not an authorization token.
globalThis.nativeWorkspaceSourceAbort=function(registration){if(!Number.isSafeInteger(registration)||registration<1)throw new RangeError('Workspace registration');if(!nativeWorkspaceSource||nativeWorkspaceSource.registration!==registration)return false;nativeWorkspaceSourceDrop(nativeWorkspaceSource);return true;};
globalThis.nativeAsyncCheck=function(ticket){nativeCapture(ticket);return true;};
globalThis.nativeAsyncBuffer=function(ticket,slot,offset,count){if(nativeWorkspaceSource?.ticket===ticket)return nativeWorkspaceSourceOperation(ticket,row=>row.capture.buffer(slot,offset,count,row.revision));return nativeCapture(ticket).buffer(slot,offset,count);};
globalThis.nativeAsyncCheckpoint=function(ticket,entry,offset,count){return nativeCapture(ticket).checkpoint(entry,offset,count);};
globalThis.nativeAsyncUI=function(ticket){return nativeCapture(ticket).ui(globalThis.nativeInput,globalThis.nativeSize);};
globalThis.nativeAsyncUIBegin=function(ticket){const capture=nativeCapture(ticket);if(nativeAsyncCapture.ui)throw new Error('Async UI capture busy');nativeAsyncCapture.ui=new AsyncUICapture(capture,globalThis.nativeInput,globalThis.nativeSize);return nativeAsyncCapture.ui.headerJSON;};
globalThis.nativeAsyncUINext=function(ticket){nativeCapture(ticket);if(!nativeAsyncCapture.ui)throw new Error('Async UI capture missing');return nativeAsyncCapture.ui.next();};
globalThis.nativeAsyncUICheck=function(ticket){nativeCapture(ticket);if(!nativeAsyncCapture.ui||!nativeAsyncCapture.ui.lastComplete)throw new Error('Async UI incomplete source transfer');return nativeAsyncCapture.ui.check(globalThis.nativeInput,globalThis.nativeSize);};
globalThis.nativeAsyncRelease=function(ticket){if(nativeWorkspaceSource?.ticket===ticket)nativeWorkspaceSourceDrop(nativeWorkspaceSource);if(nativeAsyncCapture?.ticket===ticket){nativeAsyncCapture.capture.release();nativeAsyncCapture=null;}return true;};
globalThis.nativeAsyncCreate=function(metadataJSON){if(nativeAsyncPrepared)throw new Error('Async target busy');nativeAsyncPrepared=new AsyncPrepared(metadataJSON);return true;};
globalThis.nativeAsyncTargetBuffer=function(slot,offset,count){if(!nativeAsyncPrepared)throw new Error('Async target missing');return nativeAsyncPrepared.target(slot,offset,count);};
globalThis.nativeAsyncCheckpointImport=function(entry,text){if(!nativeAsyncPrepared)throw new Error('Async target missing');nativeAsyncPrepared.checkpoint(entry,text);return true;};
globalThis.nativeAsyncStart=function(){if(!nativeAsyncPrepared)throw new Error('Async target missing');nativeAsyncPrepared.start();return true;};
globalThis.nativeAsyncStep=function(maxBars){if(!nativeAsyncPrepared)throw new Error('Async target missing');return JSON.stringify(nativeAsyncPrepared.step(maxBars));};
globalThis.nativeAsyncUIImportBegin=function(text){if(nativeAsyncPrepared instanceof NativeWorkspacePrepared)throw new Error('Workspace target does not import source UI');if(!nativeAsyncPrepared||nativeAsyncUIImport)throw new Error('Async UI target unavailable');nativeAsyncUIImport=new AsyncUIImport(text,nativeAsyncPrepared);return true;};
globalThis.nativeAsyncUIImportChunk=function(text){if(!nativeAsyncUIImport)throw new Error('Async UI target missing');nativeAsyncUIImport.chunk(text);return true;};
globalThis.nativeAsyncUIImportEnd=function(){if(!nativeAsyncUIImport)throw new Error('Async UI target missing');nativeAsyncUIPrepared=nativeAsyncUIImport.finish();nativeAsyncUIImport=null;return true;};
globalThis.nativeAsyncFinish=function(uiJSON){if(!nativeAsyncPrepared)throw new Error('Async target missing');const {model,ui}=nativeAsyncUIPrepared??nativeAsyncPrepared.finish(uiJSON),input=new InteractionController(model,()=>globalThis.nativeSize),api=new ChartAPI(model,{controller:input});input.setTool(ui.tool);api.setText(ui.text);api.setDrawingTarget(ui.drawingTarget??null);if(ui.symbol)api.setSymbol(ui.symbol);globalThis.nativeModel?.dispose();nativeLatestLayout=null;nativeLatestLayoutModel=null;globalThis.nativeModel=model;globalThis.nativeInput=input;globalThis.nativeAPI=api;globalThis.nativeSize=ui.size;nativeAsyncPrepared=null;nativeAsyncUIPrepared=null;return true;};
globalThis.nativeIndicatorBuffer=function(id,output,offset,count){const values=globalThis.nativeModel?.indicators.get(id).outputs[output];if(!(values instanceof Float64Array)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(count)||count<1||count>262144||offset+count>values.length)throw new RangeError('Native indicator slice');return values.subarray(offset,offset+count);};
globalThis.nativeInit = function(count = 100000, options = null) {
  if(options!==null&&(!options||typeof options!=='object'||Array.isArray(options)))throw new TypeError('Chart options object');
  const store = new BarStore(); store.setColumns(seededColumns(count, 42));
  const model = new ChartModel({store, axes:options?.axes??[],panels:options?.panels??[{id:'price',weight:3,...(options===null?{label:'ASTER · NATIVE'}:{})},...(options===null?[{id:'volume',weight:1,label:'VOLUME'}]:[])],visibleBars:options?.visibleBars??200,axisWidth:options?.axisWidth??82,precision:options?.precision??2});
  const size={width:1200,height:700},input=new InteractionController(model,()=>globalThis.nativeSize??size),api=new ChartAPI(model,{controller:input});
  try {
    if(options===null){model.addSeries({id:'price',type:'candles',panel:'price'});model.addSeries({id:'volume',type:'histogram',panel:'volume',source:'volume',color:'#397e8c'});model.indicators.add('ema','ema');model.addSeries({id:'ema',type:'line',panel:'price',indicator:'ema',color:'#f0b755'});}
    else {if(options.theme)api.setTheme(options.theme);for(const series of options.series??[])api.addSeries(series);}
  } catch(error) {model.dispose();throw error;}
  globalThis.nativeModel?.dispose();
  nativeLatestLayout=null;nativeLatestLayoutModel=null;globalThis.nativeModel = model; globalThis.nativeSize = {width: 1200, height: 700};
  globalThis.nativeInput = input;globalThis.nativeAPI = api;
  return count;
};
globalThis.nativeSetData = function(bars) {globalThis.nativeModel.store.setData(bars); globalThis.nativeModel.fit();};
globalThis.nativeDataEvent = function(event) {applyDataEvent(globalThis.nativeModel.store,event);};
globalThis.nativeEcho = function(value) {return value;};
globalThis.nativeCommand = function(operation,args=[]) {return nativeAPI.dispatch(operation,args);};
// Dedicated reads intentionally bypass command mutation notification routing.
globalThis.nativeSaveWorkspace=function(binding){const api=globalThis.nativeAPI,model=globalThis.nativeModel,input=globalThis.nativeInput;if(api?.model!==model)throw new Error('Workspace native owner mismatch');const text=saveWorkspace(api,binding);if(globalThis.nativeAPI!==api||globalThis.nativeModel!==model||globalThis.nativeInput!==input){const error=new Error('Workspace native owner changed');error.name='StaleSourceError';throw error;}return text;};
globalThis.nativePreflightWorkspace=function(text,binding){const api=globalThis.nativeAPI,model=globalThis.nativeModel,input=globalThis.nativeInput;if(api?.model!==model)throw new Error('Workspace native owner mismatch');const receipt=nativeWorkspacePreflight(api,text,binding);if(globalThis.nativeAPI!==api||globalThis.nativeModel!==model||globalThis.nativeInput!==input){const error=new Error('Workspace native owner changed');error.name='StaleSourceError';throw error;}return receipt;};

// Typed ingestion facades retain stable error codes across JSC/JNI without
// changing the legacy generic JS exception boundary for other commands.
globalThis.nativeDataIngestionCommand = function(operation,args=[]) {
 const allowed=['configureDataIngestion','enqueueDataEvents','drainDataEvents','pauseDataIngestion','resumeDataIngestion','cancelDataEvents','dataIngestionStats','saveDataIngestion','loadDataIngestion'];
 if(!allowed.includes(operation))throw new TypeError('Unknown ingestion command');
 try{return {result:nativeAPI.dispatch(operation,args)};}catch(error){return {error:{name:'IngestionError',code:error instanceof IngestionError?error.code:operation==='loadDataIngestion'?'INVALID_DOCUMENT':'INVALID_INPUT',message:String(error.message).slice(0,256)}};}
};
globalThis.nativeRegisterIndicatorSource = function(name,source) {nativeAPI.registerIndicatorSource(name,source);return null;};
globalThis.nativeGestureKind=function(){return nativeInput.gesture?.kind??null;};
globalThis.nativeThemeFont=function(){return nativeModel.theme.font;};
globalThis.nativeAccessibility = function(useLastFrame=false){const last=nativeModel.store.length?nativeModel.store.at(nativeModel.store.length-1):null,selected=nativeModel.drawings.items.find(d=>d.id===nativeModel.drawings.selected);const close=last?(nativeModel.priceFormatter?nativeModel.priceFormatter(last.close):last.close.toPrecision(15)):'No data',selection=selected?selected.type+(selected.locked?' locked':' editable'):'No selection',panels=nativeModel.panels.map(p=>({id:p.id,title:p.label??p.id,series:nativeModel.series.filter(s=>s.panel===p.id&&s.visible!==false).map(s=>({id:s.id,label:s.label??s.indicator??s.id,...(s.indicator?{indicator:s.indicator}:{})}))})),crosshair=nativeModel.crosshair?(useLastFrame===true&&nativeLatestLayoutModel===nativeModel&&nativeLatestLayout?.width===nativeSize.width&&nativeLatestLayout?.height===nativeSize.height?crosshairValuesAt(nativeModel,nativeLatestLayout):nativeAPI.crosshairValues(nativeSize.width,nativeSize.height)):null,readout=[`${nativeModel.store.length} bars. Close ${close}. ${selection}. Tool ${nativeInput.tool}.`,...panels.map(p=>p.title+': '+p.series.map(s=>s.label).join(', ')),...(crosshair?[`Time ${new Date(crosshair.time).toISOString()}`, ...crosshair.axes.map(a=>(a.id??a.panel)+': '+a.formatted),...crosshair.series.map(s=>s.label+': '+(s.value??'gap'))]:[])].join('. ');return {bars:nativeModel.store.length,close,selection,tool:nativeInput.tool,panels,crosshair,readout};};
globalThis.nativeIndicator = function(id,name,params,panel='price') {const data=nativeModel.indicators.add(id,name,params);for(const output of Object.keys(data.outputs))nativeModel.addSeries({id:id+'-'+output,type:'line',panel,indicator:id,output});return Object.keys(data.outputs);};
globalThis.nativeAccessibilityText=function(useLastFrame=true,platform='android'){
 if(!['android','uikit'].includes(platform))throw new TypeError('Accessibility text platform');
 const summary=nativeAccessibility(useLastFrame);
 return platform==='android'?summary.readout:[summary.bars+' bars',summary.panels.map(p=>p.title).join('; '),summary.readout,summary.selection,'tool '+summary.tool].filter(text=>text.length>0).join('; ');
};
globalThis.nativeAnalysisDemo=function(){
 const calendar=portableSessionCalendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00',kind:'regular'}],exceptions:{}}),bars=[];
 for(const day of ['2026-03-06','2026-03-09']){const first=zonedEpoch(day,'07:00','America/New_York');for(let i=0;i<600;i++){const close=100+Math.sin(i/31)*2+i*.003;bars.push({time:first+i*60000,open:close-.1,high:close+.4,low:close-.4,close,volume:100+i%73});}}
 nativeInit(0,{panels:[{id:'price',weight:3,label:'SESSION VWAP · NY / DST'},{id:'analysis-volume',weight:1,label:'CLOSE-DIRECTION VOLUME PROXY'}],series:[{id:'price',type:'candles',panel:'price'}]});
 nativeAPI.setData(bars);nativeAPI.registerIndicatorModule('aster.volume-direction',1);
 nativeAPI.addIndicator('analysis-vwap','vwap',{calendar,deviation:2});
 for(const [output,color] of [['value','#f0b755'],['upper','#58cadb'],['lower','#58cadb']])nativeAPI.addSeries({id:'analysis-vwap-'+output,type:'line',panel:'price',indicator:'analysis-vwap',output,color,label:'VWAP '+output});
 const module='aster.volume-direction@1/pressure';nativeAPI.addIndicator('analysis-pressure',module);
 nativeAPI.addSeries({id:'analysis-pressure-signed',type:'histogram',panel:'analysis-volume',indicator:'analysis-pressure',output:'signed',color:'#7898ff',label:'Volume direction proxy'});nativeAPI.fit();
 return {schema:'aster.analysis-demo',checks:5,module,setup:nativeAPI.saveStudies(),asOf:nativeAPI.indicatorValueAt('analysis-vwap','value',bars.length-1)};
};
// Demo-only fresh study container: preserve current data/layout, import before
// swapping the engine, and leave the visible chart intact on an invalid file.
globalThis.nativeAnalysisReload=function(text){
 const old=nativeModel,model=new ChartModel({store:old.store,panels:old.panels.map(p=>({...p})),axes:old.axes.map(a=>({...a})),theme:old.theme,axisWidth:old.axisWidth,precision:old.precision}),input=new InteractionController(model,()=>nativeSize),api=new ChartAPI(model,{controller:input});
 try{for(const series of old.series.filter(s=>!s.indicator)){const options=Object.fromEntries(SERIES_KEYS.filter(k=>series[k]!==undefined).map(k=>[k,series[k]]));api.addSeries(options);}const result=api.loadStudies(text);model.view={...old.view};model.follow=old.follow;old.dispose();nativeModel=model;nativeInput=input;nativeAPI=api;nativeLatestLayout=null;nativeLatestLayoutModel=null;return result;}catch(error){model.dispose();throw error;}
};
globalThis.nativeStudyVerification=function(){
 const checks=[],check=(ok,message)=>{if(!ok)throw new Error(message);checks.push(message);},bars=[10,11,11,9].map((close,i)=>({time:Date.parse('2026-03-06T14:30:00Z')+i*60000,open:close,high:close,low:close,close,volume:[5,7,8,9][i]})),store=new BarStore(bars),model=new ChartModel({store}),api=new ChartAPI(model);
 let restored=null;
 try{
  const names=api.registerIndicatorModule('aster.volume-direction',1);check(names[0]==='aster.volume-direction@1/pressure','Canonical static module name');api.addIndicator('pressure',names[0],{shift:-2});
  check(JSON.stringify(api.indicatorValues('pressure','signed'))==='[0,7,0,-9]','Independent signed-volume literal');check(JSON.stringify(api.indicatorValues('pressure','cumulative'))==='[0,7,7,-2]','Independent cumulative-volume literal');
  check(api.indicatorValueAt('pressure','signed',0,{mode:'plot',asOfIndex:0}).sourceTime===null,'Negative shift cannot leak a future timestamp');check(api.indicatorValueAt('pressure','signed',0,{mode:'plot',asOfIndex:2}).value===0,'Observed shifted source becomes available');
  const calendar=portableSessionCalendar({timezone:'America/New_York',weekdays:[1,2,3,4,5],windows:[{open:'09:30',close:'16:00'}]});api.addIndicator('vwap','vwap',{calendar,deviation:2,source:'close'});check(Math.abs(api.indicatorValueAt('vwap','value',3).value-296/29)<1e-12,'Independent session VWAP weighted mean');check(api.indicatorValueAt('vwap','deviation',0).value===0,'One positive-volume observation has zero population deviation');
  api.addSeries({id:'vwap-line',type:'line',panel:'price',indicator:'vwap',color:'#f0b755'});const saved=api.saveStudies();restored=new ChartModel({store});const restoredAPI=new ChartAPI(restored),counts=restoredAPI.loadStudies(saved);check(counts.indicators===2&&counts.series===1,'Studies atomically imported into a fresh container');check(restoredAPI.saveStudies()===saved,'Study document roundtrip keeps exact module/config/bindings');
  const before=restoredAPI.saveStudies();let rejected=false;try{restoredAPI.loadStudies(saved);}catch{rejected=true;}check(rejected&&before===restoredAPI.saveStudies(),'Duplicate import rejects without changing the chart');
  const after={time:Date.parse('2026-03-09T13:30:00Z'),open:20,high:20,low:20,close:20,volume:2};store.append(after);check(api.indicatorValueAt('vwap','value',4).value===20,'DST session open resets at literal UTC instant');store.append({...after,time:Date.parse('2026-03-09T20:00:00Z'),close:30,open:30,high:30,low:30});check(api.indicatorValueAt('vwap','value',5).value===null,'Session close is an excluded boundary');
  return {passed:checks.length,checks};
 }finally{restored?.dispose();model.dispose();}
};
globalThis.nativeView = function(from,to) {nativeModel.setVisibleRange(from,to);};
globalThis.nativeFit = function() {nativeModel.fit();};
globalThis.nativeAddPanel = function(options) {return nativeModel.addPanel(options);};
globalThis.nativeSetPanel = function(id,patch) {nativeModel.setPanel(id,patch);};
globalThis.nativeAddSeries = function(options) {return nativeModel.addSeries(options);};
globalThis.nativeRemoveSeries = function(id) {nativeModel.removeSeries(id);};
globalThis.nativeTheme = function(theme) {nativeModel.theme={...nativeModel.theme,...theme};};
globalThis.nativeInspect = function() {return JSON.stringify({view:nativeModel.view,drawings:nativeModel.drawings.items,storedBars:nativeModel.store.length,tool:nativeInput.tool,pointers:nativeInput.pointers.size,gesture:nativeInput.gesture?.kind??null});};
globalThis.nativeSceneJSON = function(width, height) {globalThis.nativeSize = {width, height}; const scene = buildScene(globalThis.nativeModel, width, height); nativeLatestLayout=scene.layout;nativeLatestLayoutModel=nativeModel;return JSON.stringify(scene);};
globalThis.nativeResize = function(width, height) {globalThis.nativeSize = {width, height};};
globalThis.nativePointer = function(kind,id,x,y,hitTolerance=8){if(!['down','move','up','cancel'].includes(kind))throw new TypeError('Pointer operation');try{if(kind==='cancel')nativeInput.cancel();else if(kind==='down')nativeInput.down(id,x,y,hitTolerance);else nativeInput[kind](id,x,y);}catch(error){nativeInput.cancel();throw error;}};
globalThis.nativeTool = function(tool) {globalThis.nativeInput.setTool(tool);};
globalThis.nativeWheel = function(delta, x) {globalThis.nativeInput.wheel(delta, x);};
globalThis.nativeKey = function(key, ctrl, shift) {globalThis.nativeInput.key(key, {ctrl, shift});};
globalThis.nativeSave = function() {return globalThis.nativeModel.drawings.save();};
globalThis.nativeLoad = function(text) {nativeAPI.loadDrawings(text);};
// Host fixture for the common mutation/notification boundary; no global model changes.
globalThis.nativePublicationOrderSelfTest=function(){
 const T=1700000000000,rows=()=>Array.from({length:32},(_,i)=>({time:T+i*60000,open:100,high:120,low:90,close:110,volume:1})),checks=[];
 for(const kind of ['reset','prepend','correction','nested']){
  const store=new BarStore(rows());let api,armed=false,seen=null;
  const stop=store.subscribe(()=>{if(!armed)return;armed=false;if(kind==='nested')api.applyDataEvent({kind:'reset',bars:rows()});api.setVisibleRange(4,14);seen=api.indicatorValues('ema')[1];}),model=new ChartModel({store});api=new ChartAPI(model);api.addIndicator('ema','ema',{period:2});
  try{armed=true;api.applyDataEvent(kind==='reset'?{kind,bars:rows().map(b=>({...b,open:200,high:240,low:180,close:220}))}:kind==='correction'?{kind,bar:{...store.at(0),volume:999}}:{kind:'prepend',bars:[{...store.at(0),time:T-60000}]});if(model.view.from!==4||model.view.to!==14||model.follow||kind==='reset'&&seen!==220||store.listenerErrors.length)throw new Error('Native publication order '+kind);checks.push(kind+' latest viewport/current indicator');}
  finally{stop();model.dispose();if(store.listeners.size)throw new Error('Native publication subscription leak');}
 }
 return {passed:checks.length,checks,input:'Direct core API; no worker transport or OS touch',physicalDevice:false};
};
globalThis.nativeSelfTest = function() {
  const assertNative = (v, message) => {if (!v) throw new Error(message);};
  const store = new BarStore(); store.setColumns(seededColumns(300, 42)); const engine = new IndicatorEngine(store); engine.add('r', 'rsi');
  const b = store.at(299); store.upsert({...b, close: b.close + .1, high: Math.max(b.high, b.close + .1)}); const incremental = engine.get('r').outputs.value[299];
  const batch = new IndicatorEngine(store); assertNative(incremental === batch.add('r', 'rsi').outputs.value[299], 'RSI correction parity');
  const q = store.aggregate(0, 300, 10); assertNative(q[0].open === store.columns.open[0] && q[q.length - 1].close === store.columns.close[299], 'OHLC preservation');
  const d = new DrawingStore(); const id = d.add({type:'trendline', panel:'price', points:[{time:1,price:2},{time:3,price:4}]}); d.begin(); d.edit(id,{points:[{time:2,price:4},{time:4,price:5}]}); d.cancel(); assertNative(d.items[0].points[0].time === 1,'Gesture cancel'); const saved=d.save(); const loaded=new DrawingStore(); loaded.load(saved); assertNative(loaded.save()===saved,'Serialization');
  nativeInit(10000); const scene=JSON.parse(nativeSceneJSON(1200,700)); assertNative(scene.stats.storedBars===10000 && scene.commands.length>10,'Native scene');
  return JSON.stringify({passed:5, runtime:globalThis.nativeRuntime??'JavaScriptCore', storedBars:10000, sceneCommands:scene.commands.length});
};
globalThis.nativeExtendedSelfTest = function() {
 const checks=[],check=(v,name)=>{if(!v)throw new Error(name);checks.push(name);};
 check(zonedEpoch('2026-03-09','09:30','America/New_York')===Date.parse('2026-03-09T13:30:00Z'),'New York DST opening');
 check(zonedEpoch('2026-11-01','01:30','America/New_York','later')-zonedEpoch('2026-11-01','01:30','America/New_York','earlier')===3600000,'DST repeated clock');
 let rejected=false;try{zonedEpoch('2026-03-08','02:30','America/New_York');}catch{rejected=true;}check(rejected,'DST nonexistent clock rejected');
 const s=new BarStore([{time:1700000000123,open:1.234567890123e-12,high:2e-12,low:1e-12,close:1.345678901234e-12,volume:7}]);
 check(s.at(0).close===1.345678901234e-12&&s.at(0).time===1700000000123,'Float64 tiny price and UTC');
 const d=new DrawingStore();d.add({type:'text',points:[{time:1700000000123,price:1.345678901234e-12}],text:'한국 🚀 café'});const saved=d.save(),restored=new DrawingStore();restored.load(saved);check(restored.items[0].text==='한국 🚀 café','Unicode text save/load');
 const m=new ChartModel({store:s,visibleBars:10});m.addSeries({id:'p',type:'candles',panel:'price'});const input=new InteractionController(m,()=>({width:1000,height:600}));input.setTool('rectangle');input.down(1,200,200);input.move(1,400,300);input.key('z',{ctrl:true});input.move(1,500,350);check(!input.gesture&&!input.pointers.size&&!m.drawings.items.length,'Undo during drag resets state');m.dispose();
 return JSON.stringify({passed:checks.length,checks,runtime:globalThis.nativeRuntime??'JavaScriptCore'});
};
globalThis.nativeHardeningSelfTest = function(){const checks=[],check=(v,name)=>{if(!v)throw new Error(name);checks.push(name);},store=new BarStore();store.setColumns(seededColumns(40));store.subscribe(()=>{throw new Error('host callback')});const model=new ChartModel({store}),api=new ChartAPI(model);model.indicators.add('e','ema');store.update(39,{...store.at(39),close:1000,high:1000});const fresh=new IndicatorEngine(store);check(model.indicators.get('e').outputs.value[39]===fresh.add('e','ema').outputs.value[39]&&store.listenerErrors.length===1,'Listener failure preserves indicator consistency');
 let rejected=false;try{api.setPanel('price',JSON.parse('{"__proto__":{"range":[1,1e309]}}'));}catch{rejected=true;}check(rejected&&Object.getPrototypeOf(model.panels[0])===Object.prototype,'Prototype patch rejected');const listeners=store.listeners.size;try{new ChartModel({store,panels:[{id:'x'},{id:'x'}]});}catch{}check(store.listeners.size===listeners,'Failed constructor releases subscriptions');
 const input={schema:'aster.drawings',version:1,drawings:[{id:'green',type:'text',panel:'price',points:[{time:store.at(10).time,price:100}],text:'green',style:{color:'rgba(0,255,0,1)',font:'18px monospace'}}]};api.loadDrawings(JSON.stringify(input));check(model.drawings.items[0].style.color==='#00ff00ff','Imported style normalized for native renderer');const saved=api.saveDrawings();input.drawings[0].style.font='1000000px monospace';rejected=false;try{api.loadDrawings(JSON.stringify(input));}catch{rejected=true;}check(rejected&&api.saveDrawings()===saved,'Oversize import atomic');
 api.addIndicator('mac','macd');api.addSeries({id:'mac',type:'line',panel:'price',indicator:'mac',output:'signal'});api.setSeries('mac',{output:null});check(model.series[0].output===undefined,'Nullable output restored');rejected=false;try{api.dispatch('registerIndicatorSource',['unsafe','(()=>{throw new Error("executed")})()']);}catch{rejected=true;}check(rejected,'Code registration excluded from data dispatch');const unit=(time,volume)=>({time,open:1,high:1,low:1,close:1,volume}),tiny=2**969,edge=new BarStore([unit(1,Number.MAX_VALUE),unit(2,0),unit(3,tiny)]),edgeVersion=edge.version;rejected=false;try{edge.append(unit(4,tiny));}catch{rejected=true;}check(rejected&&edge.length===3&&edge.version===edgeVersion&&edge.columns.time[3]===0,'Overflow append preserves data/version');fresh.dispose();model.dispose();return {passed:checks.length,checks};};
// Internal reproducible benchmark helpers, outside the data-command facade.
globalThis.nativeBenchmarkEvent=function(index){const bar=nativeModel.store.at(index);return {kind:'correction',bar:{...bar,close:1000,high:Math.max(bar.high,1000),low:Math.min(bar.low,1000)}};};
globalThis.nativeBenchmarkDigest=function(){let a=2166136261,b=2246822519,outputs=0;for(const e of nativeModel.indicators.entries.values())for(const data of e.arrays){const bits=new Uint32Array(data.buffer,data.byteOffset,nativeModel.store.length*2);for(let i=0;i<bits.length;i++){a=Math.imul(a^bits[i],16777619)>>>0;b=(Math.imul(b^bits[i],3266489917)+374761393)>>>0;}outputs++;}const scene=JSON.parse(nativeSceneJSON(1200,700));return JSON.stringify({hashes:[a,b],outputs,length:nativeModel.store.length,layout:scene.layout,last:nativeModel.store.at(nativeModel.store.length-1)});};

// Per-renderer tokens prevent one attached view consuming another view's dirty flag.
const nativeFrameCaches=new Map();
function nativeRenderFrame(token,width,height,force){if(typeof token!=='string'||token.length<1||token.length>128)throw new TypeError('Native frame token');let cache=nativeFrameCaches.get(token);if(!cache){if(nativeFrameCaches.size>=64)throw new RangeError('Native frame cache count');cache=new SceneCache();nativeFrameCaches.set(token,cache);}globalThis.nativeSize={width,height};const frame=cache.frame(nativeModel,width,height,{forceBase:force});nativeLatestLayout=frame.scene.layout;nativeLatestLayoutModel=nativeModel;return {width,height,background:frame.scene.background,base:frame.baseChanged?frame.base:null,drawings:frame.drawingsChanged?frame.drawings:null,hover:frame.hover,stats:frame.scene.stats};}
globalThis.nativeRenderFrameJSON=function(token,width,height,force=false){return JSON.stringify(nativeRenderFrame(token,width,height,force));};
globalThis.nativeScenePacket=function(mode,token,width,height,force=false){
 if(mode==='frame'){const frame=nativeRenderFrame(token,width,height,force);return packNativeCommands([frame.base,frame.drawings,frame.hover],{mode,width,height,background:frame.background,stats:frame.stats});}
 if(mode!=='scene')throw new TypeError('Native packet mode');
 globalThis.nativeSize={width,height};const scene=buildScene(nativeModel,width,height);nativeLatestLayout=scene.layout;nativeLatestLayoutModel=nativeModel;
 return packNativeCommands([scene],{mode,width,height,background:scene.background,stats:scene.stats});
};
globalThis.nativeReleaseFrameCache=function(token){const cache=nativeFrameCaches.get(token);cache?.clear();nativeFrameCaches.delete(token);nativeLatestLayout=null;nativeLatestLayoutModel=null;return true;};
globalThis.nativeReleaseFrameCaches=function(){for(const cache of nativeFrameCaches.values())cache.clear();nativeFrameCaches.clear();nativeLatestLayout=null;nativeLatestLayoutModel=null;return true;};

// Synthetic independent-axis demonstration; exact UTC join, never a carried quote.
let nativeComparisonValues=null,nativeComparisonSaved='',nativeComparisonScale=0;
globalThis.nativeComparisonDemo=function(){
  nativeInit(0,{panels:[{id:'price',weight:1,label:'A OHLCV / B ALIGNED PRICE',padding:0}],axes:[{id:'comparison-B',panel:'price',side:'left',padding:0,precision:3,prefix:'B ',label:'SYNTH:B'}],series:[{id:'comparison-A',type:'candles',panel:'price'}]});
  const bars=Array.from({length:24},(_,i)=>({time:1700000000000+i*60000,open:100+i,high:102+i,low:99+i,close:101+i,volume:1000+i}));nativeAPI.setData(bars);
  const points=bars.filter((_,i)=>[1,2,4].includes(i%6)).map(b=>({time:b.time,value:2000+(b.time-1700000000000)/6000}));
  nativeComparisonValues=alignSeriesByTime(new Float64Array(bars.map(b=>b.time)),points);nativeComparisonSaved='';nativeComparisonScale=0;
  nativeAPI.addSeries({id:'comparison-B-line',panel:'price',type:'line',axisId:'comparison-B',symbolId:'SYNTH:B',label:'B exact / gaps',values:nativeComparisonValues,color:'#f0b755',width:2});
  nativeAPI.setDrawingTarget({panel:'price',seriesId:'comparison-B-line'});nativeAPI.fit();return {bars:24,matches:12,gaps:12,primary:'A store OHLCV',foreign:'SYNTH:B aligned price',schema:2};
};
globalThis.nativeComparisonReadout=function(width=1200,height=700){const r=nativeAPI.crosshairValues(width,height),b=r?.series.find(s=>s.id==='comparison-B-line');return {text:r?`A OHLCV close ${r.primary.bar.close.toFixed(2)} / B ${b?b.value===null?'gap':b.value.toFixed(3):'removed'} / UTC ${r.time}`:'A OHLCV / B exact price · move cursor',reading:r};};
globalThis.nativeComparisonAction=function(action,width=1200,height=700,savedDocument=null){
  if(action==='setup')return nativeComparisonDemo();if(!nativeModel.axes.some(a=>a.id==='comparison-B'))throw new Error('Open comparison demo first');
  if(!nativeComparisonValues){nativeComparisonValues=nativeModel.series.find(s=>s.id==='comparison-B-line')?.values??new Float64Array(Array.from({length:nativeModel.store.length},(_,i)=>[1,2,4].includes(i%6)?2000+10*i:NaN));}if(savedDocument!==null){if(typeof savedDocument!=='string')throw new TypeError('Saved drawing document string');nativeComparisonSaved=savedDocument;}
  if(action==='hide-axis'){const a=nativeModel.axes.find(a=>a.id==='comparison-B');nativeAPI.setAxis(a.id,{visible:!a.visible});}
  else if(action==='scale'){const current=nativeModel.axes.find(a=>a.id==='comparison-B').scale,mode=['linear','log','percent'][(['linear','log','percent'].indexOf(current)+1)%3];nativeAPI.setAxis('comparison-B',{scale:mode,base:2010,padding:0,range:null});}
  else if(action==='series'){if(nativeModel.series.some(s=>s.id==='comparison-B-line'))nativeAPI.removeSeries('comparison-B-line');else nativeAPI.addSeries({id:'comparison-B-line',panel:'price',type:'line',axisId:'comparison-B',symbolId:'SYNTH:B',values:nativeComparisonValues,color:'#f0b755',width:2});}
  else if(action==='drawing')nativeAPI.addDrawing({type:'trendline',panel:'price',axisId:'comparison-B',seriesId:'comparison-B-line',points:[{time:1700000000123,price:2010},{time:1700001380000,price:2230}]});
  else if(action==='save')nativeComparisonSaved=nativeAPI.saveDrawings();
  else if(action==='load'){if(!nativeComparisonSaved)throw new Error('Save drawing document first');nativeAPI.loadDrawings(nativeComparisonSaved);}
  else if(action==='primary')nativeAPI.setDrawingTarget(null);
  else throw new TypeError('Unknown comparison action');
  return {action,axis:nativeModel.axes[0],seriesPresent:nativeModel.series.some(s=>s.id==='comparison-B-line'),drawingCount:nativeModel.drawings.items.length,savedDocument:nativeComparisonSaved,readout:nativeComparisonReadout(width,height)};
};
globalThis.nativeAxesSelfTest=function(){
  const checks=[],check=(v,name)=>{if(!v)throw new Error(name);checks.push(name);};nativeComparisonDemo();let l=createLayout(nativeModel,800,500),a=l.panels[0],b=l.axis('price','comparison-B');
  check(a.min===99&&a.max===125&&b.min===2010&&b.max===2220,'independent literal price ranges');nativeModel.crosshair={x:l.x(2),y:b.y(2100)};let r=nativeAPI.crosshairValues(800,500);check(r.primary.bar.close===103&&r.series.find(s=>s.id==='comparison-B-line').value===2020,'primary OHLCV and B price separated');nativeModel.crosshair.x=l.x(3);check(nativeAPI.crosshairValues(800,500).series.find(s=>s.id==='comparison-B-line').value===null,'exact UTC gap has no carried B quote');
  nativeAPI.setAxis('comparison-B',{scale:'log',range:[100,10000]});l=createLayout(nativeModel,800,500);b=l.axis('price','comparison-B');check(Math.abs(b.y(1000)-(b.top+b.bottom)/2)<1e-8,'log geometric midpoint');nativeAPI.setAxis('comparison-B',{scale:'percent',base:2000,range:[2000,4000],precision:1});l=createLayout(nativeModel,800,500);b=l.axis('price','comparison-B');nativeModel.crosshair={x:l.x(2),y:b.y(3000)};check(nativeAPI.crosshairValues(800,500).axes.find(a=>a.id==='comparison-B').formatted==='B 50.0%','independent percent base literal');
  const id=nativeAPI.addDrawing({type:'horizontal',panel:'price',seriesId:'comparison-B-line',points:[{time:1700000120000,price:3000}]});let d=nativeModel.drawings.items[0];check(d.axisId==='comparison-B'&&drawingGeometry(d,l)[0].coords[1]===(b.top+b.bottom)/2,'bound drawing uses B transform');const saved=nativeAPI.saveDrawings();check(JSON.parse(saved).version===2,'bound document v2');nativeAPI.setAxis('comparison-B',{visible:false});l=createLayout(nativeModel,800,500);check(drawingGeometry(d,l).length===1,'hidden axis retains drawing domain');nativeAPI.removeSeries('comparison-B-line');check(drawingGeometry(d,createLayout(nativeModel,800,500)).length===0,'removed series leaves hidden orphan');let rejected=false;try{nativeAPI.loadDrawings(saved);}catch{rejected=true;}check(rejected&&nativeAPI.saveDrawings()===saved,'missing binding import rejected atomically');nativeAPI.addSeries({id:'comparison-B-line',type:'line',panel:'price',axisId:'comparison-B',symbolId:'SYNTH:B',values:nativeComparisonValues});nativeAPI.loadDrawings(saved);check(nativeAPI.saveDrawings()===saved,'series reconnect document restores exact anchors');nativeAPI.editDrawing(id,{points:[{time:1700000120000,price:3200}]});nativeAPI.undo();check(nativeAPI.saveDrawings()===saved,'bound edit undo restores exact document');nativeAPI.redo();check(nativeModel.drawings.items[0].points[0].price===3200,'bound redo restores edited value');
  nativeComparisonDemo();return {passed:checks.length,checks,physicalDevice:false};
};

globalThis.nativeHoverExit=function(){nativeModel.crosshair=null;return true;};

})();