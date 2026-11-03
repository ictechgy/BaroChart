// Task 6 헤더 도구의 버전 고정·최소 환경·opaque 헤더 계약을 오프라인으로 검사한다.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';

import {rustupBinDirectory} from '../scripts/rust/cargo.mjs';
import {CBINDGEN_VERSION,ROOT,TOOL_CARGO_HOME,toolEnvironment} from '../scripts/rust/cbindgen-tool.mjs';

test('cbindgen is pinned and its child environment does not inherit credential variables',()=>{
 assert.equal(CBINDGEN_VERSION,'0.29.4');
 const source={
  PATH:'/host/bin',
  HOME:'/host/home',
  RUSTUP_HOME:'/host/rustup',
  BAROCHART_RUSTUP_BIN:'/host/rustup-bin',
  CARGO_REGISTRY_TOKEN:'must-not-pass',
  GITHUB_TOKEN:'must-not-pass',
  AWS_SECRET_ACCESS_KEY:'must-not-pass',
 };
 const env=toolEnvironment(false,source);
 assert.deepEqual(Object.keys(env).sort(),[
  'BAROCHART_RUSTUP_BIN','CARGO_BUILD_JOBS','CARGO_HOME','CARGO_NET_OFFLINE','PATH','RUSTUP_HOME',
 ]);
 assert.equal(env.BAROCHART_RUSTUP_BIN,'/host/rustup-bin');
 assert.equal(env.CARGO_HOME,TOOL_CARGO_HOME);
 assert.equal(env.RUSTUP_HOME,'/host/rustup');
 assert.equal(env.CARGO_BUILD_JOBS,'2');
 assert.equal(env.CARGO_NET_OFFLINE,'false');
 assert.equal(rustupBinDirectory(env),'/host/rustup-bin');
 assert.equal(env.CARGO_REGISTRY_TOKEN,undefined);
 assert.equal(env.GITHUB_TOKEN,undefined);
});

test('committed header identifies cbindgen and keeps the engine incomplete',async()=>{
 const [config,header]=await Promise.all([
  readFile(join(ROOT,'rust','cbindgen.toml'),'utf8'),
  readFile(join(ROOT,'rust','include','barochart_core.h'),'utf8'),
 ]);
 assert.match(config,/cbindgen 0\.29\.4/);
 assert.match(header,/cbindgen 0\.29\.4/);
 assert.match(header,/typedef struct BcEngine BcEngine;/);
 assert.doesNotMatch(header,/_opaque\s*\[/);
 assert.match(header,/BC_OK = 0/);
 assert.match(header,/BC_INVALID = 6/);
 assert.match(header,/bc_buf_new_copy/);
 for(const symbol of ['bc_buf_free','bc_f64_buf_free','bc_read_f64','bc_write_f64','bc_packet','bc_memory_stats','bc_supports']){
  assert.match(header,new RegExp(`\\b${symbol}\\(`),`native header must retain ${symbol}`);
 }
 assert.equal([...header.matchAll(/\bbc_engine_new\(/g)].length,1,'native constructor must have exactly one signature');
 assert.doesNotMatch(header,/\b(?:bc_alloc|bc_free|host_release|js_log|js_exp|js_hypot|zone_resolve|zone_offset_seconds)\s*\(/);
});
