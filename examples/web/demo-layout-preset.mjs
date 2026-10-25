// The main web demo stores layout metadata only.  OHLCV data, view state,
// drawing history, symbols and callbacks remain owned by the host page.
import {BarStore} from '../../src/core/data.mjs';
import {ChartModel,DARK_THEME,LIGHT_THEME} from '../../src/core/model.mjs';
import {builtinIndicators} from '../../src/core/indicators.mjs';
import {DEMO_SYMBOLS} from '../../src/core/markets.mjs';
import {validateIndicatorParams} from '../../src/core/indicator-params.mjs';
import {safeCheckpointParse,safeCheckpointStringify} from '../../src/core/checkpoint-validation.mjs';
import {modelRequest,requestOptionsSnapshot} from '../../src/web/worker-state.mjs';
import {AXIS_KEYS as CORE_AXIS_KEYS,PANEL_KEYS as CORE_PANEL_KEYS,RESOURCE_LIMITS,SERIES_KEYS as CORE_SERIES_KEYS,identifier,optionRecord,portableStyle} from '../../src/core/contracts.mjs';

export const MAX_DEMO_LAYOUT_BYTES = 512 * 1024;

const SCHEMA = 'barochart.main-demo-layout';
const VERSION = 1;
const MARKETS = new Set(['us','kr','crypto']);
const COUNTS = new Set([10000,100000,1000000]);
const ROOT_KEYS = ['schema','version','market','count','light','managed','layout'];
const REQUIRED_ROOT_KEYS = ['schema','version','market','count','light','layout'];
const LAYOUT_KEYS = ['panels','axes','series','indicators'];
const MANAGED_KEYS = ['panels','axes'];
const PANEL_KEYS = CORE_PANEL_KEYS.filter(key => key !== 'formatter');
const AXIS_KEYS = CORE_AXIS_KEYS.filter(key => key !== 'formatter');
// Symbol-aligned values and their symbol identifier are intentionally outside
// this demo document.  They can only be reconstructed by the host application.
const SERIES_KEYS = CORE_SERIES_KEYS.filter(key => !['values','symbolId'].includes(key));
const PRICE_TYPES = new Set(['candles','ohlc','line','area']);
const RESERVED_KEYS = new Set(['__proto__','constructor','prototype']);

function plainRecord(value,label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new TypeError(label+': plain object required');
  optionRecord(value,Object.keys(value),label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || RESERVED_KEYS.has(key)) throw new TypeError(label+': reserved or symbol key');
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) throw new TypeError(label+': own data fields required');
  }
  return value;
}

function denseArray(value,max,label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(label+': dense array required');
  const length = Object.getOwnPropertyDescriptor(value,'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw new RangeError(label+': limit '+max);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^\d+$/.test(key) || Number(key) >= length))) throw new TypeError(label+': dense array required');
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value,String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) throw new TypeError(label+': own data elements required');
  }
  return value;
}

function ownValue(object,key,label) {
  const descriptor = Object.getOwnPropertyDescriptor(object,key);
  if (!descriptor || !Object.hasOwn(descriptor,'value')) throw new TypeError(label+': own data field required');
  return descriptor.value;
}

function clonePrimitive(value,label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(label+': finite number required');
    return value;
  }
  throw new TypeError(label+': portable primitive required');
}

function cloneRange(value,label) {
  if (value === null) return null;
  denseArray(value,2,label);
  if (value.length !== 2) throw new TypeError(label+': range requires two values');
  return [clonePrimitive(ownValue(value,0,label),label),clonePrimitive(ownValue(value,1,label),label)];
}

function snapshotRecord(value,allowed,required,label) {
  plainRecord(value,label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(label+': unsupported field '+key.slice(0,64));
  for (const key of required) if (!Object.hasOwn(value,key)) throw new TypeError(label+': missing '+key);
  const result = {};
  for (const key of Object.keys(value)) {
    const input = ownValue(value,key,label);
    if (input === undefined) throw new TypeError(label+': undefined fields are not portable');
    result[key] = key === 'range' ? cloneRange(input,label+' range') : clonePrimitive(input,label+' '+key);
  }
  return result;
}

function snapshotParams(value,label) {
  validateIndicatorParams(value);
  const result = {};
  for (const key of Object.keys(value)) {
    const input = ownValue(value,key,label);
    result[key] = clonePrimitive(input,label+' '+key);
  }
  return result;
}

function snapshotPanel(value) { return snapshotRecord(value,PANEL_KEYS,['id'],'Demo panel'); }
function snapshotAxis(value) { return snapshotRecord(value,AXIS_KEYS,['id','panel'],'Demo axis'); }
function snapshotSeries(value) {
  const result = snapshotRecord(value,SERIES_KEYS,['id','type','panel'],'Demo series');
  return portableStyle(result,['color','fill','upColor','downColor'],true);
}
function snapshotCurrentResource(value,allowed,required,label) {
  plainRecord(value,label);
  for (const key of Object.keys(value)) {
    if (key === 'formatter' && ownValue(value,key,label) === undefined) continue;
    if (!allowed.includes(key)) throw new TypeError(label+': unsupported field '+key.slice(0,64));
  }
  for (const key of required) if (!Object.hasOwn(value,key) || ownValue(value,key,label) === undefined) throw new TypeError(label+': missing '+key);
  const result = {};
  for (const key of Object.keys(value)) {
    const input = ownValue(value,key,label);
    if (input === undefined) continue;
    result[key] = key === 'range' ? cloneRange(input,label+' range') : clonePrimitive(input,label+' '+key);
  }
  return result;
}
function snapshotIndicator(value) {
  plainRecord(value,'Demo indicator');
  for (const key of Object.keys(value)) if (!['id','name','params'].includes(key)) throw new TypeError('Demo indicator: unsupported field '+key.slice(0,64));
  for (const key of ['id','name','params']) if (!Object.hasOwn(value,key)) throw new TypeError('Demo indicator: missing '+key);
  const result = {id:clonePrimitive(ownValue(value,'id','Demo indicator id'), 'Demo indicator id'),name:clonePrimitive(ownValue(value,'name','Demo indicator name'),'Demo indicator name')};
  identifier(result.id,'Demo indicator id');
  identifier(result.name,'Demo indicator name');
  result.params = snapshotParams(value.params,'Demo indicator params');
  return result;
}

function normalizedLayout(layout) {
  plainRecord(layout,'Demo layout');
  for (const key of Object.keys(layout)) if (!LAYOUT_KEYS.includes(key)) throw new TypeError('Demo layout: unsupported field '+key.slice(0,64));
  for (const key of LAYOUT_KEYS) if (!Object.hasOwn(layout,key)) throw new TypeError('Demo layout: missing '+key);
  denseArray(layout.panels,RESOURCE_LIMITS.maxPanels,'Demo panels');
  denseArray(layout.axes,RESOURCE_LIMITS.maxAxes,'Demo axes');
  denseArray(layout.series,RESOURCE_LIMITS.maxSeries,'Demo series');
  denseArray(layout.indicators,RESOURCE_LIMITS.maxIndicators,'Demo indicators');
  return {
    panels: Array.from({length: layout.panels.length},(_,index) => snapshotPanel(ownValue(layout.panels,index,'Demo panels'))),
    axes: Array.from({length: layout.axes.length},(_,index) => snapshotAxis(ownValue(layout.axes,index,'Demo axes'))),
    series: Array.from({length: layout.series.length},(_,index) => snapshotSeries(ownValue(layout.series,index,'Demo series'))),
    indicators: Array.from({length: layout.indicators.length},(_,index) => snapshotIndicator(ownValue(layout.indicators,index,'Demo indicators'))),
  };
}

function normalizedManaged(value,layout) {
  if (value === undefined) return {panels:[],axes:[]};
  plainRecord(value,'Demo managed resources');
  for (const key of Object.keys(value)) if (!MANAGED_KEYS.includes(key)) throw new TypeError('Demo managed resources: unsupported field '+key.slice(0,64));
  for (const key of MANAGED_KEYS) if (!Object.hasOwn(value,key)) throw new TypeError('Demo managed resources: missing '+key);
  const knownPanels = new Set(layout.panels.map(panel => panel.id)), knownAxes = new Set(layout.axes.map(axis => axis.id));
  const ids = (input,max,label,known,forbidBase) => {
    denseArray(input,max,label);
    const result = [], seen = new Set();
    for (let index = 0; index < input.length; index++) {
      const id = ownValue(input,index,label);
      identifier(id,label+' id');
      if (seen.has(id)) throw new TypeError('Duplicate '+label.toLowerCase()+' id');
      if (forbidBase && (id === 'price' || id === 'volume')) throw new TypeError('Base panel cannot be managed');
      if (!known.has(id)) throw new TypeError(label+' id is not a known layout resource');
      seen.add(id); result.push(id);
    }
    return result;
  };
  return {panels:ids(ownValue(value,'panels','Demo managed resources'),RESOURCE_LIMITS.maxPanels,'Managed panel',knownPanels,true),axes:ids(ownValue(value,'axes','Demo managed resources'),RESOURCE_LIMITS.maxAxes,'Managed axis',knownAxes,false)};
}

function normalizedPreset(value) {
  plainRecord(value,'Demo layout preset');
  for (const key of Object.keys(value)) if (!ROOT_KEYS.includes(key)) throw new TypeError('Demo layout preset: unsupported field '+key.slice(0,64));
  for (const key of REQUIRED_ROOT_KEYS) if (!Object.hasOwn(value,key)) throw new TypeError('Demo layout preset: missing '+key);
  const schema = ownValue(value,'schema','Demo layout preset'), version = ownValue(value,'version','Demo layout preset'), market = ownValue(value,'market','Demo layout preset'), count = ownValue(value,'count','Demo layout preset'), light = ownValue(value,'light','Demo layout preset');
  if (schema !== SCHEMA || version !== VERSION) throw new TypeError('Demo layout schema/version');
  if (!MARKETS.has(market)) throw new TypeError('Demo layout market');
  if (!COUNTS.has(count)) throw new TypeError('Demo layout count');
  if (typeof light !== 'boolean') throw new TypeError('Demo layout light flag');
  const layout = normalizedLayout(ownValue(value,'layout','Demo layout preset'));
  const managed = normalizedManaged(Object.hasOwn(value,'managed') ? ownValue(value,'managed','Demo layout preset') : undefined,layout);
  const normalized = {schema:SCHEMA,version:VERSION,market,count,light,managed,layout};
  validateLayout(layout);
  return normalized;
}

function uniqueIdentifiers(records,key,label) {
  const seen = new Set();
  for (const record of records) {
    identifier(record[key],label);
    if (seen.has(record[key])) throw new TypeError('Duplicate '+label.toLowerCase());
    seen.add(record[key]);
  }
  return seen;
}

function validateBuiltinDefinition(name,params) {
  const factory = builtinIndicators.get(name);
  if (typeof factory !== 'function') throw new TypeError('Demo layout requires a builtin indicator');
  const definition = factory(params);
  if (!definition || !Array.isArray(definition.outputs) || !definition.outputs.length || definition.outputs.length > 32 || typeof definition.create !== 'function') throw new TypeError('Invalid builtin indicator definition');
  return definition;
}

function eachDrawing(model,callback) {
  if (!(model instanceof ChartModel) || model.disposed) throw new TypeError('Live ChartModel required');
  const drawings = model.drawings;
  if (!drawings || !Array.isArray(drawings.items) || !Array.isArray(drawings.undoStack) || !Array.isArray(drawings.redoStack)) throw new TypeError('Drawing history required');
  const visit = frame => {
    if (frame === null || frame === undefined) return;
    if (!Array.isArray(frame)) throw new TypeError('Drawing frame required');
    for (const drawing of frame) callback(drawing);
  };
  // A live transaction is a pointer gesture, not a committed drawing frame.
  // Save/load callers are expected to finish or cancel it before refreshing.
  visit(drawings.items);
  for (const frame of drawings.undoStack) visit(frame);
  for (const frame of drawings.redoStack) visit(frame);
}

export function retainedDrawingReferences(model) {
  const panelIds = new Set(), axisIds = new Set(), seriesIds = new Set();
  eachDrawing(model,drawing => {
    if (!drawing || typeof drawing !== 'object') throw new TypeError('Drawing record required');
    const panel = drawing.panel ?? 'price';
    identifier(panel,'Drawing panel'); panelIds.add(panel);
    if (drawing.axisId !== undefined && drawing.axisId !== null) { identifier(drawing.axisId,'Drawing axis'); axisIds.add(drawing.axisId); }
    if (drawing.seriesId !== undefined && drawing.seriesId !== null) { identifier(drawing.seriesId,'Drawing series'); seriesIds.add(drawing.seriesId); }
  });
  return {panelIds,axisIds,seriesIds};
}

function validateLayout(layout,currentModel=undefined) {
  const panelIds = uniqueIdentifiers(layout.panels,'id','Panel id');
  const axisIds = uniqueIdentifiers(layout.axes,'id','Axis id');
  const indicatorIds = uniqueIdentifiers(layout.indicators,'id','Indicator id');
  uniqueIdentifiers(layout.series,'id','Series id');
  if (!panelIds.has('price') || !panelIds.has('volume')) throw new TypeError('Demo layout requires price and volume panels');
  const price = layout.series.find(series => series.id === 'price'), volume = layout.series.find(series => series.id === 'volume');
  if (!price || price.panel !== 'price' || !PRICE_TYPES.has(price.type) || price.indicator !== undefined || price.output !== undefined || price.source !== undefined && !['open','high','low','close'].includes(price.source)) throw new TypeError('Demo price series binding');
  if (!volume || volume.panel !== 'volume' || volume.type !== 'histogram' || volume.source !== 'volume' || volume.indicator !== undefined || volume.output !== undefined) throw new TypeError('Demo volume series binding');

  let validator;
  try {
    validator = new ChartModel({store:new BarStore(),panels:layout.panels,axes:layout.axes});
    for (const entry of layout.indicators) {
      validateBuiltinDefinition(entry.name,entry.params);
      validator.indicators.add(entry.id,entry.name,entry.params);
    }
    for (const series of layout.series) validator.addSeries(series);
    if (currentModel !== undefined) eachDrawing(currentModel,drawing => validator.validateDrawingBinding(drawing,{allowOrphanSeries:true}));
  } finally { validator?.dispose(); }
}

function textBytes(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Demo layout Unicode scalar');
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError('Demo layout Unicode scalar');
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes > MAX_DEMO_LAYOUT_BYTES) throw new RangeError('Demo layout byte limit');
  }
  return bytes;
}

function checkTextBudget(text) {
  if (typeof text !== 'string' || text.length > MAX_DEMO_LAYOUT_BYTES) throw new RangeError('Demo layout text limit');
  textBytes(text);
  return text;
}

export function stringifyDemoLayout(preset) {
  const normalized = normalizedPreset(preset);
  const text = safeCheckpointStringify(normalized);
  return checkTextBudget(text);
}

export function parseDemoLayout(text) {
  checkTextBudget(text);
  return normalizedPreset(safeCheckpointParse(text));
}

function collectionHas(collection,id,label) {
  if (collection === undefined || collection === null) return false;
  if (!(collection instanceof Set)) throw new TypeError(label+' Set required');
  return collection.has(id);
}

function mapEntry(map,id,label) {
  if (map === undefined || map === null) return undefined;
  if (!(map instanceof Map)) throw new TypeError(label+' Map required');
  return map.get(id);
}

function sameRange(a,b) { return Array.isArray(a) && Array.isArray(b) && a.length === 2 && b.length === 2 && Object.is(a[0],b[0]) && Object.is(a[1],b[1]); }
function ownedSyntheticRange(resource,model,map) {
  const entry = mapEntry(map,resource.id,'Synthetic range');
  return !!entry && entry.model === model && entry.rangeRef === resource.range && sameRange(entry.range,resource.range);
}

export function captureDemoLayout(model,options={}) {
  if (!(model instanceof ChartModel) || model.disposed) throw new TypeError('Live ChartModel required');
  plainRecord(options,'Demo capture options');
  const captureKeys = ['market','count','light','generatedPanelIds','generatedAxisIds','syntheticPanelRanges','syntheticAxisRanges'];
  for (const key of Object.keys(options)) if (!captureKeys.includes(key)) throw new TypeError('Demo capture options: unsupported field '+key.slice(0,64));
  for (const key of ['market','count','light']) if (!Object.hasOwn(options,key)) throw new TypeError('Demo capture options: missing '+key);
  const market = ownValue(options,'market','Demo capture options'), count = ownValue(options,'count','Demo capture options'), light = ownValue(options,'light','Demo capture options');
  const generatedPanelIds = Object.hasOwn(options,'generatedPanelIds') ? ownValue(options,'generatedPanelIds','Demo capture options') : undefined;
  const generatedAxisIds = Object.hasOwn(options,'generatedAxisIds') ? ownValue(options,'generatedAxisIds','Demo capture options') : undefined;
  const syntheticPanelRanges = Object.hasOwn(options,'syntheticPanelRanges') ? ownValue(options,'syntheticPanelRanges','Demo capture options') : undefined;
  const syntheticAxisRanges = Object.hasOwn(options,'syntheticAxisRanges') ? ownValue(options,'syntheticAxisRanges','Demo capture options') : undefined;
  const request = modelRequest(model);
  const sourcePanels = new Map(model.panels.map(panel => [panel.id,panel]));
  const sourceAxes = new Map((model.axes ?? []).map(axis => [axis.id,axis]));
  const series = request.series.map(series => ({...series}));
  const boundAxes = new Set(series.map(series => series.axisId).filter(axisId => axisId !== undefined && axisId !== null));
  const axes = request.axes.filter(axis => !collectionHas(generatedAxisIds,axis.id,'Generated axis') || boundAxes.has(axis.id)).map(axis => {
    const copy = {...axis};
    const source = sourceAxes.get(axis.id);
    if (source && ownedSyntheticRange(source,model,syntheticAxisRanges)) delete copy.range;
    return copy;
  });
  const usedPanels = new Set(series.map(series => series.panel));
  for (const axis of axes) usedPanels.add(axis.panel);
  const panels = request.panels.filter(panel => !collectionHas(generatedPanelIds,panel.id,'Generated panel') || panel.id === 'price' || panel.id === 'volume' || usedPanels.has(panel.id)).map(panel => {
    const copy = {...panel};
    const source = sourcePanels.get(panel.id);
    if (source && ownedSyntheticRange(source,model,syntheticPanelRanges)) delete copy.range;
    return copy;
  });
  const managed = {panels:panels.filter(panel => !['price','volume'].includes(panel.id) && collectionHas(generatedPanelIds,panel.id,'Generated panel')).map(panel => panel.id),axes:axes.filter(axis => collectionHas(generatedAxisIds,axis.id,'Generated axis')).map(axis => axis.id)};
  return normalizedPreset({schema:SCHEMA,version:VERSION,market,count,light,managed,layout:{panels,axes,series,indicators:request.indicators.map(entry => ({id:entry.id,name:entry.name,params:{...entry.params}}))}});
}

function resourceMap(model,kind) {
  const list = kind === 'panel' ? model.panels : model.axes;
  const map = new Map();
  for (const resource of list) {
    const copy = kind === 'panel' ? snapshotCurrentResource(resource,PANEL_KEYS,['id'],'Current panel') : snapshotCurrentResource(resource,AXIS_KEYS,['id','panel'],'Current axis');
    map.set(copy.id,copy);
  }
  return map;
}

function mergeInOriginalOrder(base,retained,currentOrder) {
  const result = base.map(record => ({...record,...(record.range ? {range:[...record.range]} : {})}));
  const present = new Set(result.map(record => record.id));
  for (const id of currentOrder) if (retained.has(id) && !present.has(id)) {
    result.push(retained.get(id));
    present.add(id);
  }
  return result;
}

function mergedPreset(preset,currentModel) {
  const refs = retainedDrawingReferences(currentModel), panels = resourceMap(currentModel,'panel'), axes = resourceMap(currentModel,'axis');
  const presetPanelIds = new Set(preset.layout.panels.map(panel => panel.id));
  const presetAxisById = new Map(preset.layout.axes.map(axis => [axis.id,axis]));
  const retainedPanelIds = new Set([...refs.panelIds]);
  for (const axisId of refs.axisIds) {
    const currentAxis = axes.get(axisId);
    if (!currentAxis) throw new TypeError('Referenced drawing axis is missing');
    const imported = presetAxisById.get(axisId);
    if (imported && imported.panel !== currentAxis.panel) throw new TypeError('Referenced drawing axis imported under another panel');
    retainedPanelIds.add(currentAxis.panel);
  }
  const retainedPanels = new Map();
  for (const panelId of retainedPanelIds) if (!presetPanelIds.has(panelId)) {
    const current = panels.get(panelId);
    if (!current) throw new TypeError('Referenced drawing panel is missing');
    retainedPanels.set(panelId,current);
  }
  const retainedAxes = new Map();
  for (const axisId of refs.axisIds) if (!presetAxisById.has(axisId)) retainedAxes.set(axisId,axes.get(axisId));
  const panelOrder = currentModel.panels.map(panel => panel.id), axisOrder = currentModel.axes.map(axis => axis.id);
  const nextPanels = mergeInOriginalOrder(preset.layout.panels,retainedPanels,panelOrder);
  const nextAxes = mergeInOriginalOrder(preset.layout.axes,retainedAxes,axisOrder);
  return {schema:SCHEMA,version:VERSION,market:preset.market,count:preset.count,light:preset.light,managed:{panels:[...preset.managed.panels],axes:[...preset.managed.axes]},layout:{panels:nextPanels,axes:nextAxes,series:preset.layout.series.map(series => ({...series})),indicators:preset.layout.indicators.map(entry => ({...entry,params:{...entry.params}}))}};
}

export function validateRetainedDrawings(currentModel,value) {
  if (!(currentModel instanceof ChartModel) || currentModel.disposed) throw new TypeError('Live ChartModel required');
  plainRecord(value,'Demo drawing validation input');
  const preset = Object.hasOwn(value,'layout') ? normalizedPreset(value) : normalizedPreset({schema:SCHEMA,version:VERSION,market:'us',count:10000,light:false,layout:{panels:ownValue(value,'panels','Demo options'),axes:ownValue(value,'axes','Demo options'),series:ownValue(value,'series','Demo options'),indicators:ownValue(value,'indicators','Demo options')}});
  validateLayout(preset.layout,currentModel);
  return true;
}

export function presetOptions(preset,currentModel=undefined) {
  const normalized = normalizedPreset(preset);
  if (currentModel !== undefined && (!(currentModel instanceof ChartModel) || currentModel.disposed)) throw new TypeError('Live current ChartModel required');
  const merged = currentModel === undefined ? normalized : mergedPreset(normalized,currentModel);
  const checked = normalizedPreset(merged);
  validateLayout(checked.layout,currentModel);
  const precision = currentModel === undefined ? DEMO_SYMBOLS[checked.market].priceDecimals : currentModel.precision;
  const axisWidth = currentModel === undefined ? checked.market === 'crypto' ? 125 : 85 : currentModel.axisWidth;
  if (!Number.isInteger(precision) || precision < 0 || precision > 18 || !Number.isFinite(axisWidth) || axisWidth < 20) throw new RangeError('Demo precision/axis width');
  const options = {panels:checked.layout.panels,axes:checked.layout.axes,series:checked.layout.series,indicators:checked.layout.indicators,theme:{...(checked.light ? LIGHT_THEME : DARK_THEME)},precision,axisWidth};
  // This is the same detached request boundary used by the worker.  It also
  // rechecks builtin factories and rejects any accidental callback/module.
  return requestOptionsSnapshot(options);
}
