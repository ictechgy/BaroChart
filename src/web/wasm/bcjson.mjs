// Browser-safe lossless scalar codec used by the web WASM boundary.
// It deliberately has no Node imports. The trace codec keeps its own hashing
// and Float64Array F64 tokens; this transport codec carries actual values.

const UNSUPPORTED = 'BCJSON unsupported value';

function numberText(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return Object.is(value, -0) ? '-0' : String(value);
}

function scalar(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return null;
}

/** Encode JS values without losing NaN, infinities, undefined or -0. */
export function stringifyLossless(value) {
  const parts = []; const frames = []; const ancestors = new Set();
  const open = item => {
    const primitive = scalar(item);
    if (primitive !== null) { parts.push(primitive); return; }
    if (typeof item !== 'object' || ArrayBuffer.isView(item) || ancestors.has(item)) throw new TypeError(UNSUPPORTED);
    ancestors.add(item);
    if (Array.isArray(item)) {
      parts.push('['); frames.push({container: item, keys: null, index: 0, size: item.length});
    } else {
      const keys = Object.keys(item); parts.push('{'); frames.push({container: item, keys, index: 0, size: keys.length});
    }
  };
  open(value);
  while (frames.length) {
    const frame = frames[frames.length - 1];
    if (frame.index === frame.size) { parts.push(frame.keys ? '}' : ']'); ancestors.delete(frame.container); frames.pop(); continue; }
    if (frame.index) parts.push(',');
    const index = frame.index++;
    if (frame.keys) { const key = frame.keys[index]; parts.push(JSON.stringify(key), ':'); open(frame.container[key]); }
    else open(frame.container[index]);
  }
  return parts.join('');
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING_RUN = /[^"\\\u0000-\u001f]*/y;
const WORDS = [['true', true], ['false', false], ['null', null], ['NaN', NaN], ['-Infinity', -Infinity], ['Infinity', Infinity], ['undefined', undefined]];

function skipWhitespace(state) { while (state.index < state.text.length && ' \t\n\r'.includes(state.text[state.index])) state.index++; }
function fail(state, reason) { throw new SyntaxError(`BCJSON: ${state.index} ${reason}`); }
function readString(state) {
  const {text} = state; let index = state.index + 1; let output = '';
  for (;;) {
    STRING_RUN.lastIndex = index; const match = STRING_RUN.exec(text); if (!match) fail(state, 'invalid string');
    output += match[0]; index += match[0].length;
    if (index >= text.length) { state.index = index; fail(state, 'unterminated string'); }
    const code = text.charCodeAt(index);
    if (code === 0x22) { state.index = index + 1; return output; }
    if (code < 0x20 || text[index] !== '\\') { state.index = index; fail(state, 'invalid string'); }
    const escape = text[index + 1];
    if (escape === 'u') { const hex = text.slice(index + 2, index + 6); if (!/^[0-9a-fA-F]{4}$/.test(hex)) { state.index = index; fail(state, 'invalid escape'); } output += String.fromCharCode(Number.parseInt(hex, 16)); index += 6; continue; }
    const simple = {'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'}[escape];
    if (simple === undefined) { state.index = index; fail(state, 'invalid escape'); }
    output += simple; index += 2;
  }
}
function defineMember(container, key, value) {
  if (key === '__proto__') Object.defineProperty(container, key, {value, writable: true, enumerable: true, configurable: true});
  else container[key] = value;
}
function readKey(state) { if (state.text[state.index] !== '"') fail(state, 'expected string key'); const key = readString(state); skipWhitespace(state); if (state.text[state.index++] !== ':') fail(state, 'expected :'); return key; }
function readScalar(state) {
  const {text} = state; const index = state.index;
  if (text[index] === '"') return readString(state);
  if (text.startsWith('-Infinity', index)) { state.index += 9; return -Infinity; }
  if (text[index] === '-' || /[0-9]/.test(text[index] ?? '')) { NUMBER.lastIndex = index; const match = NUMBER.exec(text); if (!match) fail(state, 'invalid number'); state.index += match[0].length; return Number(match[0]); }
  for (const [token, value] of WORDS) if (text.startsWith(token, index)) { state.index += token.length; return value; }
  fail(state, index >= text.length ? 'unexpected end' : 'unexpected character');
}

/** Decode lossless values iteratively, so deep workspace/checkpoint documents do not recurse the JS stack. */
export function parseLossless(text) {
  const state = {text: String(text), index: 0}; const stack = []; let value;
  for (;;) {
    skipWhitespace(state); const char = state.text[state.index];
    if (char === '{') {
      state.index++; const object = {}; skipWhitespace(state);
      if (state.text[state.index] === '}') { state.index++; value = object; }
      else { stack.push({container: object, array: false, key: readKey(state)}); continue; }
    } else if (char === '[') {
      state.index++; const array = []; skipWhitespace(state);
      if (state.text[state.index] === ']') { state.index++; value = array; }
      else { stack.push({container: array, array: true}); continue; }
    } else value = readScalar(state);
    for (;;) {
      if (!stack.length) { skipWhitespace(state); if (state.index !== state.text.length) fail(state, 'trailing input'); return value; }
      const top = stack[stack.length - 1]; if (top.array) top.container.push(value); else defineMember(top.container, top.key, value);
      skipWhitespace(state); const next = state.text[state.index];
      if (next === ',') { state.index++; if (!top.array) { skipWhitespace(state); top.key = readKey(state); } break; }
      if (next === (top.array ? ']' : '}')) { state.index++; value = top.container; stack.pop(); continue; }
      fail(state, state.index >= state.text.length ? 'unexpected end' : 'expected comma or closing bracket');
    }
  }
}

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 0x02;
function copyFloat64Groups(source, target) {
  if (HOST_LITTLE_ENDIAN) { target.set(source); return; }
  for (let offset = 0; offset < source.length; offset += 8) {
    for (let byte = 0; byte < 8; byte++) target[offset + byte] = source[offset + 7 - byte];
  }
}

export function littleEndianFloat64Bytes(values) {
  if (!(values instanceof Float64Array)) throw new TypeError('Float64Array required');
  const bytes = new Uint8Array(values.byteLength);
  copyFloat64Groups(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), bytes);
  return bytes;
}

export function float64FromLittleEndianBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 8 !== 0) throw new TypeError('Float64 little-endian bytes required');
  const buffer = new ArrayBuffer(bytes.byteLength);
  copyFloat64Groups(bytes, new Uint8Array(buffer));
  return new Float64Array(buffer);
}
