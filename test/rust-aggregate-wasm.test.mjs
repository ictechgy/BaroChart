import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {wasmTargetAvailable} from '../scripts/rust/wasm-harness.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const available=wasmTargetAvailable();
test('real wasm32 aggregate keeps bucket boundaries when the index product exceeds u32',{
  skip:process.env.REQUIRE_WASM==='1'?false:!available.available&&available.reason,
},async()=>{
  const manifest=fileURLToPath(new URL('fixtures/rust-aggregate-probe/Cargo.toml',import.meta.url));
  const target=fileURLToPath(new URL('../artifacts/rust-wasm/aggregate-regression',import.meta.url));
  const built=spawnSync(process.execPath,['scripts/rust/cargo.mjs','build','--locked','--offline','--release','-j2','--target','wasm32-unknown-unknown','--manifest-path',manifest,'--target-dir',target],{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(built.status,0,built.stderr||built.stdout);
  const bytes=await readFile(`${target}/wasm32-unknown-unknown/release/aggregate_parity_probe.wasm`);
  const {instance}=await WebAssembly.instantiate(bytes);
  assert.equal(instance.exports.aggregate_probe(),131072,'the actual Core aggregate must preserve all 65,536 bucket boundaries');
});
