// Node/V8 differential harness for the Rust core's wasm32-only raw ABI.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseLossless, stringifyLossless} from '../trace/bcjson.mjs';
import {rustupBinDirectory} from './cargo.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NODE = process.execPath;
const MAX_U32 = 0xffff_ffff;
const RUSTUP = join(rustupBinDirectory(process.env), 'rustup');

/** Returns whether the pinned local rustup toolchain already has the WASM target installed. */
export function wasmTargetAvailable() {
  if (!existsSync(RUSTUP)) return {available: false, reason: `rustup was not found at ${RUSTUP}`};
  const result = spawnSync(RUSTUP, ['target', 'list', '--installed', '--toolchain', '1.98.1'], {encoding: 'utf8'});
  if (result.error || result.status !== 0) return {available: false, reason: result.error?.message ?? result.stderr.trim() ?? 'rustup query failed'};
  const installed = result.stdout.split(/\r?\n/).map(value => value.trim());
  return installed.includes('wasm32-unknown-unknown')
    ? {available: true, reason: ''}
    : {available: false, reason: 'rustup toolchain 1.98.1 does not have wasm32-unknown-unknown installed'};
}

function runCargo(args, targetDirectory) {
  const result = spawnSync(NODE, ['scripts/rust/cargo.mjs', ...args], {
    cwd: ROOT,
    env: {...process.env, CARGO_TARGET_DIR: targetDirectory},
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo wrapper failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function inRange(pointer, length, memoryBytes) {
  pointer = Number(pointer) >>> 0;
  length = Number(length) >>> 0;
  return Number.isInteger(pointer) && Number.isInteger(length) && pointer >= 0 && length >= 0
    && pointer <= memoryBytes && length <= memoryBytes - pointer;
}

function canonicalZone(name) {
  return new Intl.DateTimeFormat('en-US', {timeZone: name}).resolvedOptions().timeZone;
}

function offsetSeconds(name, epochMilliseconds) {
  if (!Number.isFinite(epochMilliseconds)) return -0x8000_0000;
  const epochSecond = Math.floor(epochMilliseconds / 1000);
  const instant = new Date(epochSecond * 1000);
  if (!Number.isFinite(instant.getTime())) return -0x8000_0000;
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: name, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(({type, value}) => [type, Number(value)]));
  const localAsUTC = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) / 1000;
  const result = localAsUTC - epochSecond;
  return Number.isInteger(result) && result > -0x8000_0000 && result <= 0x7fff_ffff ? result : -0x8000_0000;
}

/** Builds the local wasm32 cdylib and returns an owner for its Rust engine. */
export async function createWasmHarness({targetDirectory = join(ROOT, 'artifacts/rust-wasm/harness-target'), profile = 'release'} = {}) {
  assert.ok(profile === 'release' || profile === 'debug', 'WASM profile must be release or debug');
  const targetDir = resolve(ROOT, targetDirectory);
  runCargo(['build', '--offline', '--locked', ...(profile === 'release' ? ['--release'] : []), '-j2', '-p', 'barochart-wasm', '--target', 'wasm32-unknown-unknown'], targetDir);
  const wasmPath = join(targetDir, `wasm32-unknown-unknown/${profile === 'release' ? 'release' : 'debug'}/barochart_wasm.wasm`);
  const wasmBytes = await readFile(wasmPath);
  // WASM panic=unwind propagation requires exception-handling support; this harness does not claim that boundary until verified separately.
  const module = await WebAssembly.compile(wasmBytes);
  const releaseCounts = new Map();
  const hostContexts = new Set();
  const unexpectedReleases = [];
  const importCalls = {js_log: 0, js_exp: 0, js_hypot: 0, zone_resolve: 0, zone_offset_seconds: 0};
  let instance;
  let engine = 0;
  let disposed = false;
  let disposePromise;
  let nextHostId = 1;
  const hostId = nextHostId++;
  hostContexts.add(hostId);

  const memoryView = () => {
    assert.ok(instance?.exports.memory, 'WASM module did not export linear memory');
    return new DataView(instance.exports.memory.buffer);
  };
  const bytesView = () => new Uint8Array(instance.exports.memory.buffer);
  const writeHostBytes = (pointer, length, outputPointer, outputCapacity, transform) => {
    try {
      pointer >>>= 0; length >>>= 0; outputPointer >>>= 0; outputCapacity >>>= 0;
      const memoryBytes = instance.exports.memory.buffer.byteLength;
      if (!inRange(pointer, length, memoryBytes) || !inRange(outputPointer, outputCapacity, memoryBytes)) return -1;
      const bytes = new TextEncoder().encode(transform(new TextDecoder('utf-8', {fatal: true}).decode(bytesView().subarray(pointer, pointer + length))));
      if (bytes.length === 0 || bytes.length > outputCapacity) return -1;
      bytesView().set(bytes, outputPointer);
      return bytes.length;
    } catch {return -1}
  };

  const wasmImports = {env: {
    js_log: value => {importCalls.js_log++;try {return Math.log(value)} catch {return Number.NaN}},
    js_exp: value => {importCalls.js_exp++;try {return Math.exp(value)} catch {return Number.NaN}},
    js_hypot: (left, right) => {importCalls.js_hypot++;try {return Math.hypot(left, right)} catch {return Number.NaN}},
    zone_resolve: (requestedHost, pointer, length, outputPointer, outputCapacity) => {
      importCalls.zone_resolve++;
      requestedHost >>>= 0;
      if (!hostContexts.has(requestedHost)) return -1;
      return writeHostBytes(pointer, length, outputPointer, outputCapacity, canonicalZone);
    },
    zone_offset_seconds: (requestedHost, pointer, length, epochMilliseconds) => {
      importCalls.zone_offset_seconds++;
      try {
        requestedHost >>>= 0; pointer >>>= 0; length >>>= 0;
        if (!hostContexts.has(requestedHost) || !inRange(pointer, length, instance.exports.memory.buffer.byteLength)) return -0x8000_0000;
        const name = new TextDecoder('utf-8', {fatal: true}).decode(bytesView().subarray(pointer, pointer + length));
        return offsetSeconds(name, epochMilliseconds);
      } catch {return -0x8000_0000}
    },
    host_release: requestedHost => {
      requestedHost >>>= 0;
      releaseCounts.set(requestedHost, (releaseCounts.get(requestedHost) ?? 0) + 1);
      if (!hostContexts.delete(requestedHost)) unexpectedReleases.push(requestedHost);
    },
  }};
  instance = await WebAssembly.instantiate(module, wasmImports);

  const requiredExports = ['memory', 'bc_alloc', 'bc_call', 'bc_engine_free', 'bc_engine_new', 'bc_free'];
  assert.deepEqual(WebAssembly.Module.exports(module).map(({name}) => name).sort(), requiredExports.sort(), 'WASM export surface changed');
  const imports = WebAssembly.Module.imports(module).map(({module: source, name}) => `${source}.${name}`).sort();
  assert.deepEqual(imports, ['env.host_release', 'env.js_exp', 'env.js_hypot', 'env.js_log', 'env.zone_offset_seconds', 'env.zone_resolve']);

  function allocate(length) {
    assert.ok(Number.isInteger(length) && length > 0 && length <= MAX_U32, 'WASM allocation length is out of range');
    const pointer = instance.exports.bc_alloc(length) >>> 0;
    if (!pointer) throw new Error(`bc_alloc(${length}) failed`);
    if (pointer % 8 !== 0) {
      instance.exports.bc_free(pointer, length);
      throw new Error('WASM allocator did not return an 8-byte-aligned pointer');
    }
    return pointer;
  }

  function free(pointer, length) {
    pointer >>>= 0; length >>>= 0;
    if (pointer !== 0 || length !== 0) instance.exports.bc_free(pointer, length);
  }

  function descriptor(pointer) {
    pointer >>>= 0;
    if (!inRange(pointer, 12, instance.exports.memory.buffer.byteLength) || pointer % 4 !== 0) throw new Error('Invalid WASM buffer descriptor range');
    const view = memoryView();
    const dataPointer = view.getUint32(pointer, true);
    const length = view.getUint32(pointer + 4, true);
    const capacity = view.getUint32(pointer + 8, true);
    if (dataPointer === 0) {
      if (length !== 0 || capacity !== 0) throw new Error('Noncanonical empty WASM buffer');
      return {pointer: 0, length: 0, capacity: 0};
    }
    if (dataPointer % 8 !== 0 || length !== capacity || !inRange(dataPointer, capacity, instance.exports.memory.buffer.byteLength)) {
      throw new Error('Invalid owned WASM byte buffer');
    }
    return {pointer: dataPointer, length, capacity};
  }

  function releaseDescriptor(output) {
    const value = descriptor(output);
    if (value.pointer) free(value.pointer, value.capacity);
  }

  const engineOut = allocate(4), errorOut = allocate(12);
  try {
    const status = instance.exports.bc_engine_new(hostId, engineOut, errorOut);
    const view = memoryView();
    engine = view.getUint32(engineOut, true);
    const error = descriptor(errorOut);
    if (status !== 0) {
      hostContexts.delete(hostId);
      const message = error.pointer ? new TextDecoder().decode(bytesView().subarray(error.pointer, error.pointer + error.length)) : `BC status ${status}`;
      throw new Error(`WASM bc_engine_new failed: ${message}`);
    }
    if (!engine) throw new Error('WASM bc_engine_new returned an empty handle');
    if (error.pointer) throw new Error('Successful WASM bc_engine_new returned an error buffer');
  } catch (error) {
    if (engine) {
      const rejected = engine;
      engine = 0;
      instance.exports.bc_engine_free(rejected);
    } else {
      hostContexts.delete(hostId);
    }
    throw error;
  } finally {
    releaseDescriptor(errorOut);
    free(engineOut, 4);
    free(errorOut, 12);
  }

  const harness = {
    instance,
    module,
    get engine() {return engine},
    get hostReleaseCount() {return releaseCounts.get(hostId) ?? 0},
    get unexpectedReleaseCount() {return unexpectedReleases.length},
    get importCalls() {return {...importCalls}},
    allocate,
    free,
    async call(name, args) {
      if (disposed || !engine) throw new Error('WASM harness is disposed');
      const nameBytes = new TextEncoder().encode(name);
      const argsBytes = new TextEncoder().encode(stringifyLossless(args));
      const namePointer = allocate(nameBytes.length), argsPointer = allocate(argsBytes.length), output = allocate(12);
      try {
        bytesView().set(nameBytes, namePointer);
        bytesView().set(argsBytes, argsPointer);
        const status = instance.exports.bc_call(engine, namePointer, nameBytes.length, argsPointer, argsBytes.length, 1, output);
        const owned = descriptor(output);
        const text = owned.pointer ? new TextDecoder('utf-8', {fatal: true}).decode(bytesView().subarray(owned.pointer, owned.pointer + owned.length)) : '';
        let value;
        try {value = text ? parseLossless(text) : undefined} finally {if (owned.pointer) free(owned.pointer, owned.capacity)}
        if (status === 0) return {status, value};
        if (status === 1 || status === 2) return {status, error: value};
        return {status, error: value};
      } finally {
        free(namePointer, nameBytes.length);
        free(argsPointer, argsBytes.length);
        free(output, 12);
      }
    },
    async compare(name, args) {
      const source = await readFile(join(ROOT, 'native/Resources/aster-core.js'), 'utf8');
      const context = vm.createContext({Intl});
      vm.runInContext(source, context, {timeout: 5_000});
      const callable = context[name];
      assert.equal(typeof callable, 'function', `VM function missing: ${name}`);
      const javascript = Reflect.apply(callable, context, args);
      const rust = await harness.call(name, args);
      return {javascript, rust, equal: rust.status === 0 && stringifyLossless(rust.value) === stringifyLossless(javascript)};
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      if (engine) {
        const closing = engine;
        engine = 0;
        instance.exports.bc_engine_free(closing);
      }
      disposePromise = Promise.resolve();
      return disposePromise;
    },
  };
  return harness;
}
