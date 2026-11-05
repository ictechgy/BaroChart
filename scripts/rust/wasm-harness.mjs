// Node/V8 differential harness for the Rust core's wasm32-only raw ABI.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
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

function runCargo(args, targetDirectory, environment = {}) {
  const result = spawnSync(NODE, ['scripts/rust/cargo.mjs', ...args], {
    cwd: ROOT,
    env: {...process.env, ...environment, CARGO_INCREMENTAL: '0', CARGO_TARGET_DIR: targetDirectory},
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo wrapper failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

/** Reports whether the explicit, repository-local EH preparation has completed. */
export function wasmEHCachePrepared() {
  return existsSync(join(ROOT, 'artifacts/rust-wasm/stdlib-cache/cargo-home/config.toml'))
    && existsSync(join(ROOT, 'artifacts/rust-wasm/eh-toolchain/bin/rustc-with-sysroot'));
}

function exceptionHandlingEnvironment() {
  const result = spawnSync(process.env.PYTHON || 'python3', ['scripts/rust/prepare-wasm-eh.py', '--offline', '--json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`WASM EH preparation failed:\n${result.stderr || result.stdout}`);
  const {environment} = JSON.parse(result.stdout);
  assert.ok(environment && typeof environment.RUSTC === 'string' && environment.RUSTC_BOOTSTRAP === '1', 'Invalid WASM EH environment');
  return environment;
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
export async function createWasmHarness({targetDirectory, profile = 'release', prebuiltPath = null, exceptionHandling = false} = {}) {
  assert.ok(profile === 'release' || profile === 'debug', 'WASM profile must be release or debug');
  assert.ok(!(prebuiltPath && exceptionHandling), 'EH verification must build the current source');
  const targetDir = resolve(ROOT, targetDirectory ?? join(ROOT, 'artifacts/rust-wasm', exceptionHandling ? 'eh-stdlib-target' : 'harness-target'));
  if (!prebuiltPath) runCargo([
    'build', '--offline', '--locked', ...(exceptionHandling ? ['-Zbuild-std=std,panic_unwind'] : []),
    ...(profile === 'release' ? ['--release'] : []), '-j2', '-p', 'barochart-wasm', '--target', 'wasm32-unknown-unknown',
  ], targetDir, exceptionHandling ? exceptionHandlingEnvironment() : {});
  const wasmPath = prebuiltPath ? resolve(ROOT, prebuiltPath) : join(targetDir, `wasm32-unknown-unknown/${profile === 'release' ? 'release' : 'debug'}/barochart_wasm.wasm`);
  const wasmBytes = await readFile(wasmPath);
  // The explicit EH mode rebuilds std; the normal precompiled std does not provide panic recovery.
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

  const requiredExports = [
    'memory', 'bc_alloc', 'bc_call', 'bc_engine_free', 'bc_engine_new', 'bc_free',
    'bc_web_abi_version', 'bc_web_capabilities', 'bc_web_memory_stats',
    'bc_web_packet', 'bc_web_read_f64', 'bc_web_write_f64',
  ];
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
    webAbiVersion() {
      return instance.exports.bc_web_abi_version();
    },
    webBytes(pointer) {
      const owned = descriptor(pointer);
      const bytes = owned.pointer
        ? new Uint8Array(bytesView().slice(owned.pointer, owned.pointer + owned.length))
        : new Uint8Array();
      if (owned.pointer) free(owned.pointer, owned.capacity);
      return bytes;
    },
    webCall(name, args = [], flags = 1) {
      const nameBytes = new TextEncoder().encode(name);
      const argsBytes = new TextEncoder().encode(stringifyLossless(args));
      const namePointer = allocate(nameBytes.length), argsPointer = allocate(argsBytes.length), output = allocate(12);
      try {
        bytesView().set(nameBytes, namePointer);
        bytesView().set(argsBytes, argsPointer);
        const status = instance.exports.bc_web_read_f64(
          engine, namePointer, nameBytes.length, argsPointer, argsBytes.length, flags, output,
        );
        const owned = descriptor(output);
        let value;
        try {
          const raw = owned.pointer ? bytesView().slice(owned.pointer, owned.pointer + owned.length) : new Uint8Array();
          value = status === 0 ? raw : raw.length ? parseLossless(new TextDecoder('utf-8', {fatal: true}).decode(raw)) : undefined;
        } finally {if (owned.pointer) free(owned.pointer, owned.capacity)}
        return {status, value};
      } finally {
        free(namePointer, nameBytes.length); free(argsPointer, argsBytes.length); free(output, 12);
      }
    },
    webCapabilities() {
      const output = allocate(12);
      try {
        const status = instance.exports.bc_web_capabilities(engine, output);
        const owned = descriptor(output);
        try {
          const raw = owned.pointer ? new TextDecoder('utf-8', {fatal: true}).decode(bytesView().subarray(owned.pointer, owned.pointer + owned.length)) : '';
          return {status, value: raw ? JSON.parse(raw) : undefined};
        } finally {if (owned.pointer) free(owned.pointer, owned.capacity)}
      } finally {free(output, 12)}
    },
    webWriteF64(name, args, values, flags = 1) {
      const nameBytes = new TextEncoder().encode(name);
      const argsBytes = new TextEncoder().encode(stringifyLossless(args));
      const sourceBytes = values.length * 8;
      const namePointer = allocate(nameBytes.length), argsPointer = allocate(argsBytes.length), sourcePointer = sourceBytes ? allocate(sourceBytes) : 0, didWrite = allocate(4), error = allocate(12);
      try {
        bytesView().set(nameBytes, namePointer); bytesView().set(argsBytes, argsPointer);
        if (sourcePointer) {
          const view = new DataView(instance.exports.memory.buffer);
          values.forEach((value, index) => view.setFloat64(sourcePointer + index * 8, value, true));
        }
        const status = instance.exports.bc_web_write_f64(engine, namePointer, nameBytes.length, argsPointer, argsBytes.length, flags, sourcePointer, values.length, didWrite, error);
        const wrote = new DataView(instance.exports.memory.buffer).getUint32(didWrite, true);
        const owned = descriptor(error);
        const message = owned.pointer ? parseLossless(new TextDecoder('utf-8', {fatal: true}).decode(bytesView().subarray(owned.pointer, owned.pointer + owned.length))) : undefined;
        if (owned.pointer) free(owned.pointer, owned.capacity);
        return {status, didWrite: wrote, error: message};
      } finally {
        free(namePointer, nameBytes.length); free(argsPointer, argsBytes.length); if (sourcePointer) free(sourcePointer, sourceBytes); free(didWrite, 4); free(error, 12);
      }
    },
    webWriteF64Bits(name, args, bits, flags = 1) {
      const nameBytes = new TextEncoder().encode(name), argsBytes = new TextEncoder().encode(stringifyLossless(args));
      const sourceBytes = bits.length * 8, namePointer = allocate(nameBytes.length), argsPointer = allocate(argsBytes.length), sourcePointer = sourceBytes ? allocate(sourceBytes) : 0, didWrite = allocate(4), error = allocate(12);
      try {
        bytesView().set(nameBytes, namePointer); bytesView().set(argsBytes, argsPointer);
        if (sourcePointer) {const view = new DataView(instance.exports.memory.buffer);bits.forEach((value,index)=>view.setBigUint64(sourcePointer + index * 8, BigInt(value), true));}
        const status = instance.exports.bc_web_write_f64(engine,namePointer,nameBytes.length,argsPointer,argsBytes.length,flags,sourcePointer,bits.length,didWrite,error);
        const wrote = new DataView(instance.exports.memory.buffer).getUint32(didWrite,true), owned = descriptor(error);
        const message = owned.pointer ? parseLossless(new TextDecoder('utf-8',{fatal:true}).decode(bytesView().subarray(owned.pointer,owned.pointer+owned.length))) : undefined;
        if (owned.pointer) free(owned.pointer,owned.capacity);
        return {status,didWrite:wrote,error:message};
      } finally {free(namePointer,nameBytes.length);free(argsPointer,argsBytes.length);if(sourcePointer)free(sourcePointer,sourceBytes);free(didWrite,4);free(error,12);}
    },
    webPacket(args = []) {
      const argsBytes = new TextEncoder().encode(stringifyLossless(args)), argsPointer = allocate(argsBytes.length), metadata = allocate(12), numbers = allocate(12);
      try {
        bytesView().set(argsBytes,argsPointer);
        const status = instance.exports.bc_web_packet(engine,argsPointer,argsBytes.length,metadata,numbers), read = pointer => {const owned=descriptor(pointer);const bytes=owned.pointer?bytesView().slice(owned.pointer,owned.pointer+owned.length):new Uint8Array();if(owned.pointer)free(owned.pointer,owned.capacity);return bytes;};
        return {status,metadata:read(metadata),numbers:read(numbers)};
      } finally {free(argsPointer,argsBytes.length);free(metadata,12);free(numbers,12);}
    },
    webMemoryStats() {
      const output=allocate(12);try{const status=instance.exports.bc_web_memory_stats(engine,output),owned=descriptor(output);const value=owned.pointer?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytesView().subarray(owned.pointer,owned.pointer+owned.length))):undefined;if(owned.pointer)free(owned.pointer,owned.capacity);return{status,value};}finally{free(output,12);}
    },
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
        let value;
        try {
          const text = owned.pointer ? new TextDecoder('utf-8', {fatal: true}).decode(bytesView().subarray(owned.pointer, owned.pointer + owned.length)) : '';
          value = text ? parseLossless(text) : undefined;
        } finally {if (owned.pointer) free(owned.pointer, owned.capacity)}
        if (status === 0) return {status, value};
        return {status, error: value};
      } finally {
        free(namePointer, nameBytes.length);
        free(argsPointer, argsBytes.length);
        free(output, 12);
      }
    },
    // A fresh nativeInit smoke oracle is sufficient only for initialization. Stateful callers
    // provide a reused oracle or run the checked-in core-conformance scenarios.
    async compare(name, args, {oracle: ownedOracle} = {}) {
      assert.ok(ownedOracle || name === 'nativeInit', 'Stateful comparisons require a caller-owned oracle; use runScenario');
      const {createJavaScriptOracle} = await import('./core-conformance.mjs');
      const oracle = ownedOracle ?? await createJavaScriptOracle();
      const expected = oracle.call(name, args);
      const javascript = expected.value;
      const rust = await harness.call(name, args);
      return {javascript, rust, equal: rust.status === expected.status && stringifyLossless(rust.status === 0 ? rust.value : rust.error) === stringifyLossless(expected.status === 0 ? javascript : expected.error)};
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
