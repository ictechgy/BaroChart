import {registerStoreOwner,unregisterStoreOwner} from './store-owners.mjs';
import {BarStore, RangeIndex} from './data.mjs';
import {IndicatorEngine} from './indicators.mjs';
import {DrawingStore} from './drawings.mjs';
import {BlockRangeIndex} from './block-index.mjs';
import {aggregateVolumeSeries} from './scene-parts.mjs';
import {labelMetrics} from './labels.mjs';
import {optionRecord,identifier,boundedText,PANEL_KEYS,AXIS_KEYS,SERIES_KEYS,THEME_KEYS,RESOURCE_LIMITS} from './contracts.mjs';

// Keep small-series flat queries; large series use the existing32-value blocks.
// This is shared with background preparation so ready caches need no conversion.
export const SERIES_BLOCK_THRESHOLD = 65536;

function axisStripWidths(panels,axes,axisWidth){
  let left=0,right=0;
  for(const panel of panels){let rowLeft=0,rowRight=0;if(panel.axisVisible!==false){if(panel.axisSide==='left')rowLeft=axisWidth;else rowRight=axisWidth;}
    for(const axis of axes)if(axis.panel===panel.id&&axis.visible){if(axis.side==='left')rowLeft+=axis.width??axisWidth;else rowRight+=axis.width??axisWidth;}
    left=Math.max(left,rowLeft);right=Math.max(right,rowRight);
  }
  return [left,right];
}

export const DARK_THEME = {background: '#0c1320', grid: '#1d2a3a', text: '#8093ad', up: '#35d2ab', down: '#fa6c7c', crosshair: '#b9c9de', font: '12px monospace'};
export const LIGHT_THEME = {background: '#f8fafc', grid: '#dfe6ee', text: '#53657d', up: '#078d6d', down: '#df344b', crosshair: '#304158', font: '12px monospace'};
export class ChartModel {
  constructor({store = new BarStore(), theme = DARK_THEME, panels = [{id: 'price', weight: 3}], axes = [], visibleBars = 200, axisWidth = 82, precision = 2} = {}) {
    if (!panels.length || !Number.isFinite(axisWidth) || axisWidth < 20 || !Number.isFinite(visibleBars) || visibleBars < 1 || !Number.isInteger(precision) || precision < 0 || precision > 18) throw new RangeError('Panels, width, visible bars or precision');
    if(!(store instanceof BarStore))throw new TypeError('BarStore required');optionRecord(theme,THEME_KEYS,'Theme');for(const value of Object.values(theme))boundedText(value,256,'Theme value');
    this.store = store; this.theme = {...DARK_THEME, ...theme}; this.panels = []; this.axes = []; this.series = []; this.seriesValueRevisions = new WeakMap(); this.axisWidth = axisWidth; this.precision = precision;
    this.view = {from: Math.max(-.5, store.length - visibleBars - .5), to: Math.max(visibleBars - .5, store.length - .5)}; this.crosshair = null; this.follow = true;
    // A nonempty backfill rebases existing anchors. First history has none:
    // follow the tail like append, or retain an explicitly unfollowed view.
    panels.forEach(p => this.addPanel(p));if(!Array.isArray(axes))throw new TypeError('Axes array required');axes.forEach(a=>this.addAxis(a));this.indicators=new IndicatorEngine(store);try{this.drawings=new DrawingStore(); this.unsubscribe = store._subscribeInternal(({kind, from, added, appended}) => {if(kind==='compact')return;if (kind === 'prepend' && store.length > added) {this.view.from += added; this.view.to += added;} else if (kind === 'reset') this.fit(); if ((kind === 'append'||kind==='batch'&&appended>0||kind==='prepend'&&added>0&&store.length===added) && this.follow) {const span = this.view.to - this.view.from; this.view.to = store.length + this.forwardOffset() - .5; this.view.from = this.view.to - span;} for (const s of this.series) s.dirtyFrom = Math.min(s.dirtyFrom ?? Infinity, from);});registerStoreOwner(this,store,'model');}catch(error){try{this.indicators.dispose();}catch{}throw error;}
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
    // Extend a blocked index at the final dirty row first, so earlier appended
    // blocks are rescanned with the complete length rather than a partial tail.
    if (s.dirtyFrom < Infinity || s.revision !== revision || !s.rangeIndex || s.rangeIndex.finiteCounts!==true || policyMismatch) {const start = Math.min(s.dirtyFrom ?? Infinity, computedFrom); if (s.indicator&&s.revision!==undefined&&revision>s.revision+1 || !s.rangeIndex || s.rangeIndex.finiteCounts!==true || policyMismatch || s.rangeIndex.size !== this.store.capacity || computedUntil - start > values.length / 4) s.rangeIndex = blocked?new BlockRangeIndex(values.length,values,this.store.capacity):new RangeIndex(values.length, values, values, null, this.store.capacity, true); else {if(s.rangeIndex instanceof BlockRangeIndex){if(computedUntil>start)s.rangeIndex.update(computedUntil-1);for(let i=start;i<computedUntil;i+=s.rangeIndex.blockSize)s.rangeIndex.update(i);}else for(let i=start;i<computedUntil;i++)s.rangeIndex.update(i,values[i]);}s.revision = revision;s.dirtyFrom = Infinity;}
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
  const lo=transform(min),hi=transform(max);if(!Number.isFinite(lo)||!Number.isFinite(hi))throw new RangeError('Axis transform overflow');
  const delta=hi-lo,direct=Number.isFinite(delta)&&delta!==0,magnitude=Math.max(Math.abs(lo),Math.abs(hi))||1,scaledLo=lo/magnitude,scaledHi=hi/magnitude,span=scaledHi-scaledLo;
  if(!direct&&(!Number.isFinite(span)||span===0))throw new RangeError('Axis transform has no representable span');
  // TwoDiff retains the low part of hi-lo for inverse interpolation across
  // zero, without double-rounding subnormal weighted endpoint products.
  const virtualLo=direct?hi-delta:0,deltaError=direct?(hi-(delta+virtualLo))+(virtualLo-lo):0;
  // Subtract before scaling to retain narrow binary64 price differences. Very
  // wide domains and off-range values still need the overflow-safe fallback.
  const origin=config.inverted?lo:hi,extent=config.inverted?delta:-delta,scaledOrigin=config.inverted?scaledLo:scaledHi,scaledExtent=config.inverted?span:-span,pixels=bottom-top;
  const y=direct?value=>{const mapped=transform(value),difference=mapped-origin,fraction=Number.isFinite(difference)?difference/extent:(mapped/magnitude-scaledOrigin)/scaledExtent,coordinate=top+fraction*pixels;return coordinate>=-3.4028234663852886e38&&coordinate<=3.4028234663852886e38?coordinate:NaN;}:value=>{const coordinate=top+(transform(value)/magnitude-scaledOrigin)/scaledExtent*pixels;return coordinate>=-3.4028234663852886e38&&coordinate<=3.4028234663852886e38?coordinate:NaN;};
  if(Number.isFinite(sourceMin)&&(!Number.isFinite(Math.fround(y(sourceMin)))||!Number.isFinite(Math.fround(y(sourceMax)))))throw new RangeError('Axis projection overflow for visible values');
  const price=sy=>{const fraction=(sy-top)/(bottom-top),f=config.inverted?fraction:1-fraction;let value=direct?(f<=.5?lo+f*delta:hi-(1-f)*delta):NaN;if(direct&&deltaError!==0)value+=f<=.5?f*deltaError:-(1-f)*deltaError;if(!Number.isFinite(value))value=((1-f)*scaledLo+f*scaledHi)*magnitude;return inverse(value);};
  return {...config,left,right,top,bottom,min,max,base,y,price,transform,inverse,lo,hi};
}
export function createLayout(model,width,height) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<100||height<80||width>RESOURCE_LIMITS.maxCanvasDimension||height>RESOURCE_LIMITS.maxCanvasDimension)throw new RangeError('Chart needs at least 100 × 80 CSS pixels');
  const configs=model.panels.map(p=>[{...p,axisId:null,side:p.axisSide??'right',visible:p.axisVisible!==false,width:model.axisWidth},...model.axes.filter(a=>a.panel===p.id).map(a=>({...a,axisId:a.id,width:a.width??model.axisWidth}))]);
  const [leftStrip,rightStrip]=axisStripWidths(model.panels,model.axes,model.axisWidth);
  const factor=Math.min(1,(width-32)/(leftStrip+rightStrip||1)),left=12+leftStrip*factor,right=Math.max(left+20,width-rightStrip*factor),maxWeight=Math.max(...model.panels.map(p=>p.weight)),total=model.panels.reduce((n,p)=>n+p.weight/maxWeight,0),a=Math.min(model.store.length,Math.max(0,Math.floor(model.view.from))),b=Math.max(a,Math.min(model.store.length,Math.ceil(model.view.to+1)));
  const footer=Math.min(height-24,Math.max(38,Math.ceil(labelMetrics(model.theme.font).height+20))),panelSpace=height-footer;let top=12;
  const panels=model.panels.map((p,i)=>{const row=panelSpace*(p.weight/maxWeight/total),gap=Math.min(8,row/2),bottom=top+row-gap,series=model.series.filter(s=>s.panel===p.id&&s.visible!==false);let lx=left,rx=right;
    const axes=configs[i].map(config=>{const q=axisRange(model,config,series.filter(s=>(s.axisId??null)===config.axisId),a,b,left,right,top,bottom);const w=config.visible?config.width*factor:0;q.axisLeft=config.side==='left'?lx-w:rx;q.axisRight=q.axisLeft+w;q.textX=config.side==='left'?q.axisLeft+4:q.axisLeft+8;if(config.side==='left')lx-=w;else rx+=w;return q;});
    const result={...axes[0],axes};top=bottom+gap;return result;});
  const axis=(panelId,axisId=null)=>panels.find(p=>p.id===panelId)?.axes.find(a=>a.axisId===(axisId??null));
  const drawingAxis=d=>{if(d.seriesId!==undefined&&d.seriesId!==null){const s=model.series.find(s=>s.id===d.seriesId);if(!s||s.visible===false||s.panel!==d.panel||(s.axisId??null)!==(d.axisId??null))return undefined;}return axis(d.panel,d.axisId);};
  const x=index=>left+(index-model.view.from)/(model.view.to-model.view.from)*(right-left),index=sx=>model.view.from+(sx-left)/(right-left)*(model.view.to-model.view.from);
  const geometryKey=JSON.stringify([width,height,model.view.from,model.view.to,model.store.geometryIdentity,model.store.timeVersion,...panels.flatMap(p=>p.axes.map(a=>[p.id,a.axisId,a.left,a.right,a.top,a.bottom,a.min,a.max,a.scale,a.inverted,a.base])),...model.series.map(s=>[s.id,s.panel,s.axisId,s.visible])]);
  return {geometryKey,geometryFont:model.theme.font,width,height,panels,axis,drawingAxis,x,index,from:a,to:b,toScreen:(point,panelId,axisId=null)=>{const p=axis(panelId,axisId);return p?{x:x(model.store.indexAtTime(point.time)),y:p.y(point.price)}:{x:NaN,y:NaN};},fromScreen:(sx,sy,panelId,axisId=null)=>{const p=axis(panelId,axisId);if(!p)throw new Error('Missing axis');return {time:model.store.timeAtIndex(index(sx)),price:p.price(sy)};}};
}
