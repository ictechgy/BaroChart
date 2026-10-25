import {ChartModel} from '../../src/core/model.mjs';
import {AXIS_KEYS,PANEL_KEYS,identifier} from '../../src/core/contracts.mjs';

const PANEL_FRAME_KEYS = PANEL_KEYS.filter(key => key !== 'id' && key !== 'formatter');
const AXIS_FRAME_KEYS = AXIS_KEYS.filter(key => key !== 'id' && key !== 'panel' && key !== 'formatter');
const FRAME_KEYS = ['panelOrder','placements','generatedPanels','generatedAxes'];
const PANEL_SET_KEYS = new Set(PANEL_FRAME_KEYS);
const AXIS_SET_KEYS = new Set(AXIS_FRAME_KEYS);
const MAX_FRAME_ITEMS = 256;
const MAX_LABEL_LENGTH = 128;

function plainRecord(value,label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new TypeError(label+': plain object required');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key)) throw new TypeError(label+': string own keys required');
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) throw new TypeError(label+': own data fields required');
  }
  return value;
}

function denseArray(value,label,max=MAX_FRAME_ITEMS) {
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

function ownValue(value,key,label,required=false) {
  const descriptor = Object.getOwnPropertyDescriptor(value,key);
  if (!descriptor) {
    if (required) throw new TypeError(label+': missing '+key);
    return undefined;
  }
  if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value')) throw new TypeError(label+': own data field required');
  return descriptor.value;
}

function primitive(value,label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(label+': portable primitive required');
}

function cloneRange(value,label) {
  if (value === null) return null;
  denseArray(value,label,2);
  if (value.length !== 2) throw new TypeError(label+': two values required');
  return [primitive(ownValue(value,0,label),label),primitive(ownValue(value,1,label),label)];
}

function cloneOptions(value,keys,label) {
  plainRecord(value,label);
  const allowed = keys === 'panel' ? PANEL_SET_KEYS : AXIS_SET_KEYS;
  const result = {};
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(label+': unsupported field '+key);
    const input = ownValue(value,key,label);
    if (input === undefined) throw new TypeError(label+': undefined fields are not portable');
    result[key] = key === 'range' ? cloneRange(input,label+' range') : primitive(input,label+' '+key);
  }
  return result;
}

function clonePlacement(value,label) {
  plainRecord(value,label);
  const keys = ['seriesId','indicatorId','panelId','axisId'];
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) throw new TypeError(label+': exact fields required');
  if (own.some(key => !keys.includes(key))) throw new TypeError(label+': unsupported field');
  const seriesId = primitive(ownValue(value,'seriesId',label),label+' seriesId');
  const indicatorId = primitive(ownValue(value,'indicatorId',label),label+' indicatorId');
  const panelId = primitive(ownValue(value,'panelId',label),label+' panelId');
  const axisInput = ownValue(value,'axisId',label);
  const axisId = axisInput === null ? null : primitive(axisInput,label+' axisId');
  identifier(seriesId,label+' seriesId');
  identifier(indicatorId,label+' indicatorId');
  identifier(panelId,label+' panelId');
  if (axisId !== null) identifier(axisId,label+' axisId');
  return {seriesId,indicatorId,panelId,axisId};
}

function cloneGeneratedPanel(value,label) {
  plainRecord(value,label);
  const keys = ['id','options'];
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some(key => !Object.hasOwn(value,key)) || own.some(key => !keys.includes(key))) throw new TypeError(label+': exact fields required');
  const id = primitive(ownValue(value,'id',label),label+' id');
  identifier(id,label+' id');
  return {id,options:cloneOptions(ownValue(value,'options',label),'panel',label+' options')};
}

function cloneGeneratedAxis(value,label) {
  plainRecord(value,label);
  const keys = ['id','panel','options'];
  const own = Object.keys(value);
  if (own.length !== keys.length || keys.some(key => !Object.hasOwn(value,key)) || own.some(key => !keys.includes(key))) throw new TypeError(label+': exact fields required');
  const id = primitive(ownValue(value,'id',label),label+' id');
  const panel = primitive(ownValue(value,'panel',label),label+' panel');
  identifier(id,label+' id');
  identifier(panel,label+' panel');
  return {id,panel,options:cloneOptions(ownValue(value,'options',label),'axis',label+' options')};
}

function cloneFrame(value,label='Layout frame') {
  plainRecord(value,label);
  const own = Object.keys(value);
  if (own.length !== FRAME_KEYS.length || FRAME_KEYS.some(key => !Object.hasOwn(value,key)) || own.some(key => !FRAME_KEYS.includes(key))) throw new TypeError(label+': exact fields required');
  const panelOrderInput = denseArray(ownValue(value,'panelOrder',label),label+' panelOrder');
  const panelOrder = panelOrderInput.map((id,index) => {
    const result = primitive(id,label+' panelOrder '+index); identifier(result,label+' panelOrder '+index); return result;
  });
  if (panelOrder.length === 0) throw new TypeError(label+': at least one panel required');
  if (new Set(panelOrder).size !== panelOrder.length) throw new TypeError(label+': duplicate panel order id');
  const placementsInput = denseArray(ownValue(value,'placements',label),label+' placements');
  const placements = placementsInput.map((entry,index) => clonePlacement(entry,label+' placement '+index));
  const placementIds = new Set();
  for (const entry of placements) {
    if (placementIds.has(entry.seriesId)) throw new TypeError(label+': duplicate placement series id');
    placementIds.add(entry.seriesId);
  }
  const generatedPanelsInput = denseArray(ownValue(value,'generatedPanels',label),label+' generatedPanels');
  const generatedPanels = generatedPanelsInput.map((entry,index) => cloneGeneratedPanel(entry,label+' generatedPanel '+index));
  const generatedPanelIds = new Set();
  for (const entry of generatedPanels) {
    if (generatedPanelIds.has(entry.id)) throw new TypeError(label+': duplicate generated panel id');
    generatedPanelIds.add(entry.id);
    if (!panelOrder.includes(entry.id)) throw new TypeError(label+': generated panel is not in panel order');
  }
  const generatedAxesInput = denseArray(ownValue(value,'generatedAxes',label),label+' generatedAxes');
  const generatedAxes = generatedAxesInput.map((entry,index) => cloneGeneratedAxis(entry,label+' generatedAxis '+index));
  const generatedAxisIds = new Set();
  for (const entry of generatedAxes) {
    if (generatedAxisIds.has(entry.id)) throw new TypeError(label+': duplicate generated axis id');
    generatedAxisIds.add(entry.id);
    if (!panelOrder.includes(entry.panel)) throw new TypeError(label+': generated axis panel is not in panel order');
  }
  return {panelOrder,placements,generatedPanels,generatedAxes};
}

function isLiveModel(model) {
  return model instanceof ChartModel && model.disposed !== true;
}

function readModelArray(model,key,label) {
  const value = ownValue(model,key,'ChartModel',true);
  if (value === undefined) throw new TypeError(label+': model field required');
  return denseArray(value,label,256);
}

function mapInput(value,label) {
  if (value === undefined) return undefined;
  if (!(value instanceof Map)) throw new TypeError(label+' Map required');
  return value;
}

function idSet(value,label,known) {
  if (value === undefined) return new Set();
  if (!(value instanceof Set)) throw new TypeError(label+' Set required');
  const result = new Set();
  for (const id of value) {
    identifier(id,label+' id');
    if (known && !known.has(id)) throw new Error(label+' id is missing');
    result.add(id);
  }
  return result;
}

function sameRange(a,b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 2 && b.length === 2 && Object.is(a[0],b[0]) && Object.is(a[1],b[1]);
}

function ownsSyntheticRange(model,resource,pins) {
  if (!pins || !Array.isArray(resource.range) || resource.range.length !== 2) return false;
  const entry = pins.get(resource.id);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const values = entry.values ?? entry.range;
  return entry.model === model && entry.rangeRef === resource.range && sameRange(values,resource.range);
}

function snapshotResource(resource,keys,label,synthetic) {
  plainRecord(resource,label);
  const options = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(resource,key);
    if (!descriptor) continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor,'value')) throw new TypeError(label+': own data field required');
    const input = descriptor.value;
    if (input === undefined) continue;
    options[key] = key === 'range' ? cloneRange(input,label+' range') : primitive(input,label+' '+key);
  }
  if (synthetic && Object.hasOwn(options,'range')) delete options.range;
  return options;
}

function modelFrame(model,options={}) {
  if (!isLiveModel(model)) throw new TypeError('Live ChartModel required');
  plainRecord(options,'Layout capture options');
  const allowed = ['generatedPanelIds','generatedAxisIds','syntheticPanelRanges','syntheticAxisRanges'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new TypeError('Layout capture options: unsupported field '+key);
  const panels = readModelArray(model,'panels','Chart panels');
  const axes = readModelArray(model,'axes','Chart axes');
  const series = readModelArray(model,'series','Chart series');
  const panelOrder = [];
  const panelIds = new Set();
  const panelById = new Map();
  for (const [index,panel] of panels.entries()) {
    plainRecord(panel,'Chart panel '+index);
    const id = primitive(ownValue(panel,'id','Chart panel '+index,true),'Chart panel id'); identifier(id,'Chart panel id');
    if (panelIds.has(id)) throw new TypeError('Duplicate panel id');
    panelIds.add(id);
    panelOrder.push(id); panelById.set(id,panel);
  }
  const axisIds = new Set();
  const axisById = new Map();
  for (const [index,axis] of axes.entries()) {
    plainRecord(axis,'Chart axis '+index);
    const id = primitive(ownValue(axis,'id','Chart axis '+index,true),'Chart axis id'); identifier(id,'Chart axis id');
    const panel = primitive(ownValue(axis,'panel','Chart axis '+index,true),'Chart axis panel'); identifier(panel,'Chart axis panel');
    if (!panelIds.has(panel)) throw new Error('Chart axis panel is missing');
    if (axisIds.has(id)) throw new TypeError('Duplicate axis id');
    axisIds.add(id);
    axisById.set(id,{axis,panel});
  }
  const generatedPanelIds = idSet(options.generatedPanelIds,'Generated panel',panelIds);
  const generatedAxisIds = idSet(options.generatedAxisIds,'Generated axis',axisIds);
  const syntheticPanelRanges = mapInput(options.syntheticPanelRanges,'Synthetic panel ranges');
  const syntheticAxisRanges = mapInput(options.syntheticAxisRanges,'Synthetic axis ranges');
  const placements = [];
  const seriesIds = new Set();
  for (const [index,entry] of series.entries()) {
    plainRecord(entry,'Chart series '+index);
    const id = primitive(ownValue(entry,'id','Chart series '+index,true),'Chart series id'); identifier(id,'Chart series id');
    if (seriesIds.has(id)) throw new TypeError('Duplicate series id');
    seriesIds.add(id);
    const indicator = ownValue(entry,'indicator','Chart series '+index);
    if (indicator === undefined || indicator === null) continue;
    const indicatorId = primitive(indicator,'Chart series indicator'); identifier(indicatorId,'Chart series indicator');
    const panelId = primitive(ownValue(entry,'panel','Chart series '+index,true),'Chart series panel'); identifier(panelId,'Chart series panel');
    if (!panelIds.has(panelId)) throw new Error('Chart series panel is missing');
    const axisInput = ownValue(entry,'axisId','Chart series '+index);
    const axisId = axisInput === undefined || axisInput === null ? null : primitive(axisInput,'Chart series axis');
    if (axisId !== null) {
      identifier(axisId,'Chart series axis');
      const axis = axisById.get(axisId);
      if (!axis || axis.panel !== panelId) throw new Error('Chart series axis is missing');
    }
    placements.push({seriesId:id,indicatorId,panelId,axisId});
  }
  const generatedPanels = [];
  for (const id of panelOrder) if (generatedPanelIds.has(id)) generatedPanels.push({id,options:snapshotResource(panelById.get(id),PANEL_FRAME_KEYS,'Generated panel '+id,ownsSyntheticRange(model,panelById.get(id),syntheticPanelRanges))});
  const generatedAxes = [];
  for (const [id,{axis,panel}] of axisById) if (generatedAxisIds.has(id)) generatedAxes.push({id,panel,options:snapshotResource(axis,AXIS_FRAME_KEYS,'Generated axis '+id,ownsSyntheticRange(model,axis,syntheticAxisRanges))});
  return cloneFrame({panelOrder,placements,generatedPanels,generatedAxes});
}

export function captureLayoutFrame(model,options={}) {
  return modelFrame(model,options);
}

function valueKey(input) {
  if (input === null) return 'null';
  if (typeof input === 'string') return 's'+JSON.stringify(input);
  if (typeof input === 'boolean') return input ? 'b1' : 'b0';
  if (typeof input === 'number') return Object.is(input,-0) ? 'n-0' : 'n'+String(input);
  if (Array.isArray(input)) return 'a['+input.map(valueKey).join(',')+']';
  return 'o{'+Object.keys(input).sort().map(key => JSON.stringify(key)+':'+valueKey(input[key])).join(',')+'}';
}

function semanticKey(frame) {
  return valueKey(cloneFrame(frame));
}

function equalFrame(a,b) {
  return semanticKey(a) === semanticKey(b);
}

function samePlacement(a,b) {
  return a?.seriesId === b?.seriesId && a?.indicatorId === b?.indicatorId && a?.panelId === b?.panelId && Object.is(a?.axisId,b?.axisId);
}

function frameIntentSatisfied(actual,target) {
  const targetPanels = new Set(target.panelOrder);
  const relativePanels = actual.panelOrder.filter(id => targetPanels.has(id));
  if (relativePanels.length !== target.panelOrder.length || relativePanels.some((id,index) => id !== target.panelOrder[index])) return false;
  if (actual.placements.length !== target.placements.length) return false;
  const actualPlacements = new Map(actual.placements.map(entry => [entry.seriesId,entry]));
  for (const placement of target.placements) if (!samePlacement(actualPlacements.get(placement.seriesId),placement)) return false;
  const actualPanels = new Map(actual.generatedPanels.map(entry => [entry.id,entry]));
  for (const panel of target.generatedPanels) {
    const current = actualPanels.get(panel.id);
    if (!current) return false;
  }
  const actualAxes = new Map(actual.generatedAxes.map(entry => [entry.id,entry]));
  for (const axis of target.generatedAxes) {
    const current = actualAxes.get(axis.id);
    if (!current || current.panel !== axis.panel) return false;
  }
  return true;
}

function error(name,message) {
  const result = new Error(message);
  result.name = name;
  return result;
}

export function createLayoutHistory({getModel,capture=captureLayoutFrame,apply,maxEntries=30}={}) {
  if (typeof getModel !== 'function') throw new TypeError('getModel function required');
  if (typeof capture !== 'function') throw new TypeError('capture function required');
  if (typeof apply !== 'function') throw new TypeError('apply function required');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 30) throw new RangeError('maxEntries must be an integer from 1 to 30');

  let boundModel;
  let generation = 0;
  let expectedFrame;
  let commands = [];
  let cursor = 0;
  let active = null;
  const tokens = new WeakMap();

  let initial;
  try { initial = getModel(); } catch (cause) { throw error('LayoutHistoryOwnerError','getModel failed'); }
  if (initial !== null && initial !== undefined && !isLiveModel(initial)) throw new TypeError('getModel must return a live ChartModel');
  boundModel = isLiveModel(initial) ? initial : null;
  generation = boundModel ? 1 : 0;

  function currentModel() {
    let current;
    try { current = getModel(); } catch { return null; }
    return isLiveModel(current) ? current : null;
  }

  function ownerCanBind(model) {
    let current;
    try { current = getModel(); } catch { return false; }
    return current === null || current === undefined || current === model;
  }

  function isBound() {
    return currentModel() === boundModel && isLiveModel(boundModel);
  }

  function captureCurrent(model=boundModel) {
    if (!isLiveModel(model)) throw new TypeError('Live ChartModel required');
    return cloneFrame(capture(model),'Captured layout frame');
  }

  function initializeExpected() {
    if (expectedFrame !== undefined) return true;
    if (!isBound()) return false;
    expectedFrame = captureCurrent();
    return true;
  }

  function clearTo(frame) {
    commands = [];
    cursor = 0;
    expectedFrame = cloneFrame(frame,'Layout frame');
  }

  function clearUnknown() {
    commands = [];
    cursor = 0;
    expectedFrame = undefined;
  }

  function reconcileCurrent({throwOnCapture=false}={}) {
    if (!isBound()) return false;
    let actual;
    try { actual = captureCurrent(); }
    catch (cause) {
      clearUnknown();
      if (throwOnCapture) throw cause;
      return false;
    }
    if (!isBound()) return false;
    if (expectedFrame === undefined) { expectedFrame = actual; return true; }
    if (!equalFrame(actual,expectedFrame)) { clearTo(actual); return false; }
    return true;
  }

  function ownerError() {
    return error('LayoutHistoryOwnerError','Chart model owner changed; reset required');
  }

  function tokenRecord(token) {
    const record = token && typeof token === 'object' ? tokens.get(token) : undefined;
    if (!record || record.token !== token || record.consumed || active !== record) throw new Error('Invalid or inactive layout history token');
    if (!isBound() || record.model !== boundModel || record.generation !== generation) throw ownerError();
    return record;
  }

  function finishToken(record) {
    record.consumed = true;
    if (active === record) active = null;
  }

  function handleApplyFailure(before) {
    if (generation !== before.generation || boundModel !== before.model || !isBound()) return;
    let actual;
    try { actual = captureCurrent(); }
    catch { clearUnknown(); return; }
    if (!isBound()) return;
    if (!equalFrame(actual,before.frame)) clearTo(actual);
  }

  function syncApply(target,from) {
    const start = {model:boundModel,generation,frame:cloneFrame(expectedFrame)};
    let result;
    try {
      result = apply(cloneFrame(target,'Layout history target'));
    } catch (cause) {
      handleApplyFailure(start);
      throw cause;
    }
    if (generation !== start.generation || boundModel !== start.model || !isBound()) return false;
    let actual;
    try { actual = captureCurrent(); }
    catch (cause) { clearUnknown(); throw cause; }
    if (generation !== start.generation || boundModel !== start.model || !isBound()) return false;
    if (result === false || !frameIntentSatisfied(actual,target)) {
      if (!equalFrame(actual,start.frame)) clearTo(actual);
      return false;
    }
    expectedFrame = cloneFrame(actual,'Layout history result');
    if (from === 'undo') cursor -= 1; else cursor += 1;
    return true;
  }

  function begin(label) {
    if (active) throw new Error('Layout history transaction already active');
    if (typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_LENGTH) throw new TypeError('Layout history label required');
    if (!isBound()) throw ownerError();
    initializeExpected();
    if (!isBound()) throw ownerError();
    if (!reconcileCurrent()) {
      if (!isBound() || expectedFrame === undefined) throw error('LayoutHistoryExternalChange','Unrecorded layout change; reset required');
    }
    const before = cloneFrame(expectedFrame,'Layout history before');
    const token = {before:cloneFrame(before),model:boundModel,generation};
    const record = {token,before,model:boundModel,generation,label,consumed:false};
    tokens.set(token,record); active = record;
    return token;
  }

  function commit(token) {
    const record = tokenRecord(token);
    try {
      const after = captureCurrent();
      if (!isBound() || generation !== record.generation || boundModel !== record.model) throw ownerError();
      if (equalFrame(record.before,after)) return false;
      if (cursor < commands.length) commands = commands.slice(0,cursor);
      commands.push({label:record.label,before:cloneFrame(record.before),after:cloneFrame(after)});
      cursor += 1;
      while (commands.length > maxEntries) { commands.shift(); cursor = Math.max(0,cursor-1); }
      expectedFrame = cloneFrame(after);
      return true;
    } finally { finishToken(record); }
  }

  function cancel(token) {
    const record = tokenRecord(token);
    try {
      if (!isBound()) return false;
      const actual = captureCurrent();
      if (!isBound()) return false;
      if (!equalFrame(actual,record.before)) { clearTo(actual); return false; }
      return true;
    } finally { finishToken(record); }
  }

  function navigate(direction) {
    if (active) throw new Error('Layout history transaction already active');
    if (!isBound() || !initializeExpected()) return false;
    if (!reconcileCurrent()) return false;
    const command = direction === 'undo' ? commands[cursor-1] : commands[cursor];
    if (!command) return false;
    return syncApply(direction === 'undo' ? command.before : command.after,direction);
  }

  function undo() { return navigate('undo'); }
  function redo() { return navigate('redo'); }

  function reset(model=getModel()) {
    if (!isLiveModel(model)) throw new TypeError('reset requires a live ChartModel');
    if (!ownerCanBind(model)) throw ownerError();
    const frame = captureCurrent(model);
    if (!ownerCanBind(model)) throw ownerError();
    if (active) { active.consumed = true; active = null; }
    boundModel = model;
    generation += 1;
    commands = [];
    cursor = 0;
    expectedFrame = frame;
    return true;
  }

  function status() {
    if (!isBound() || expectedFrame === undefined) return {canUndo:false,canRedo:false,undoLabel:null,redoLabel:null,depth:0,cursor:0};
    const undoCommand = commands[cursor-1], redoCommand = commands[cursor];
    return {canUndo:cursor > 0,canRedo:cursor < commands.length,undoLabel:undoCommand?.label ?? null,redoLabel:redoCommand?.label ?? null,depth:commands.length,cursor};
  }

  return {begin,commit,cancel,undo,redo,reset,status};
}
