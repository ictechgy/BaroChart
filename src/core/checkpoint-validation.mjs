// Internal checkpoint integrity, shared by browser workers and native QuickJS.
// This module deliberately has no TextEncoder/TextDecoder or host scheduling API.
import {indicatorModule,validateModuleCheckpoint} from './indicator-modules.mjs';
import {validateIndicatorParams} from './indicator-params.mjs';
import {validateSessionCheckpoint} from './session-studies.mjs';
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
export function safeCheckpointStringify(state) {
  checkpointWalk(state, false, 0, {nodes: 0}, new Set());
  const text = JSON.stringify(state, (_key, value) => typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)) ? {$asterNumber: Object.is(value, -0) ? '-0' : String(value)} : value);
  if (typeof text !== 'string' || text.length > CHECKPOINT_MAX_TEXT) throw new RangeError('Checkpoint text limit');
  return text;
}
export function safeCheckpointParse(text) {
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
function checkpointInitialEquals(value, expected) {
  if (Object.is(value, expected)) return true;
  if (!value || !expected || typeof value !== 'object' || typeof expected !== 'object' || Array.isArray(value) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected); return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && checkpointInitialEquals(value[key], expected[key]));
}
const checkpointInitialStates = {
  sma:{},ema:{},wma:{},rsi:{previous:NaN},atr:{previous:NaN},macd:{},bollinger:{mean:0,m2:0,a:[],head:0},donchian:{},stochastic:{},roc:{a:[],head:0},williamsR:{},cci:{},
  obv:{previous:NaN,value:0},vwap:{session:NaN,pv:0,v:0},mfi:{previous:NaN},cmf:{},adx:{previous:null},dema:{},tema:{},hma:{},keltner:{previous:NaN},
  supertrend:{previous:NaN,upper:NaN,lower:NaN,direction:1},ichimoku:{},trix:{previous:NaN},ppo:{},stochRSI:{previous:NaN,valid:0},adl:{value:0},chaikin:{value:0},forceIndex:{previous:NaN},volumeOscillator:{},vortex:{previous:null},
  pivots:{session:NaN,high:NaN,low:NaN,close:NaN,levels:[NaN,NaN,NaN,NaN,NaN]},parabolicSAR:{previous:null,older:null,sar:NaN,ep:NaN,af:.02,direction:1}
};
export function validateCheckpointState(name, params, state, index) {
  checkpointInteger(index, 0, CHECKPOINT_MAX_HISTORY);validateIndicatorParams(params);
  if(indicatorModule(name))return validateModuleCheckpoint(name,params,state,index);
  if(name==='vwap'||name==='pivots'){const validated=validateSessionCheckpoint(name,params,state,index);if(validated!==null)return validated;}
  if (!Object.hasOwn(checkpointInitialStates, name)) checkpointFail('builtin name');
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
