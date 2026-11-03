// Rust 도구 테스트: 이식 코드 금지 패턴 검사기(scripts/rust/check-bans.mjs)와 cargo 래퍼(scripts/rust/cargo.mjs).
// cargo는 부르지 않는다. 래퍼는 홈(또는 CARGO_HOME)의 bin에 둔 가짜 cargo로 PATH·cwd·인자·종료 코드 전달을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {constants,tmpdir} from 'node:os';
import {delimiter,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findBans,findManifestBans} from '../scripts/rust/check-bans.mjs';

/** 저장소 루트(이 파일 기준이라 테스트를 어느 cwd에서 돌려도 같다) */
const root=fileURLToPath(new URL('..',import.meta.url));
/** 검사기 CLI 경로 */
const checkBansScript=join(root,'scripts/rust/check-bans.mjs');
/** cargo 래퍼 CLI 경로 */
const cargoScript=join(root,'scripts/rust/cargo.mjs');

/**
 * 소스에서 걸린 규칙 이름만 위치 순서대로 뽑는다.
 * @param {string} source 러스트 소스
 * @param {'ported'|'kernel'} profile 규칙 묶음
 * @returns {string[]} 규칙 이름 목록
 */
const rulesIn=(source,profile)=>findBans(source,profile).map(finding=>finding.rule);

/**
 * 파일 표를 새 임시 디렉터리에 쓴다.
 * @param {string} prefix 임시 디렉터리 이름 앞부분
 * @param {Record<string,string>} files 상대 경로 → 내용
 * @returns {Promise<string>} 임시 디렉터리 경로(호출자가 지운다)
 */
async function temporaryTree(prefix,files){
 const dir=await mkdtemp(join(tmpdir(),prefix));
 for(const [path,text] of Object.entries(files)){
  await mkdir(dirname(join(dir,path)),{recursive:true});
  await writeFile(join(dir,path),text);
 }
 return dir;
}

/**
 * 검사기 CLI를 저장소 밖 cwd에서 실행한다.
 * @param {string[]} args 검사기 인자
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 실행 결과
 */
const runCheckBans=args=>spawnSync(process.execPath,[checkBansScript,...args],{cwd:tmpdir(),encoding:'utf8'});

test('ported code rejects precision and exponent formats that round ties to even',()=>{
 for(const source of [
  'let s = format!("{:.2}", x);',
  'write!(f, "{:e}", x)?;',
  'let s = format!("{value:>8.3}");',
  'let s = format!("{:.*}", 2, x);',
  'let s = format!("{0:.prec$}", x, prec = 2);',
  'let s = format!("{:E}", x);',
  'let s = format!(r#"[{:.1}]"#, x);',
 ])assert.deepEqual(rulesIn(source,'ported'),['float-format'],source);
});

test('ported code rejects f64 helpers whose NaN, -0 and tie rules differ from JS Math',()=>{
 for(const [source,expected] of [
  ['let m = a.max(b);',['float-min-max']],
  ['let m = a\n    .min(\n        b);',['float-min-max']],
  ['let m = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);',['float-min-max']],
  ['let m = f64::min(a, b);',['float-min-max']],
  ['let r = x.round();',['float-round']],
  ['let r = f64::round(x);',['float-round']],
  ['let s = x.signum();',['float-signum']],
  ['let y = a.mul_add(b, c);',['mul-add']],
 ])assert.deepEqual(rulesIn(source,'ported'),expected,source);
});

test('ported code rejects std whitespace trimming and serde',()=>{
 for(const [source,expected] of [
  ['let t = name.trim();',['str-trim']],
  ['let t = name.trim_start();',['str-trim']],
  ['let t = str::trim_end(name);',['str-trim']],
  ['let t = bytes.trim_ascii();',['str-trim']],
  ['let t = name.trim_right();',['str-trim']],
  ['use serde::Deserialize;',['serde']],
  ['let v: Value = serde_json::from_str(text)?;',['serde']],
  ['#[serde(rename = "x")]',['serde']],
 ])assert.deepEqual(rulesIn(source,'ported'),expected,source);
});

test('comments, strings, char literals and lifetimes hide their text but never the code after them',()=>{
 for(const [source,expected] of [
  [String.raw`/// Rust {:.2} rounds half to even and f64::max drops NaN
//! x.trim() differs from JS trim
let r = x.round();`,['float-round']],
  [String.raw`/* outer /* inner */ a.max(b) */ let r = x.round();`,['float-round']],
  [String.raw`let s = "he said \"x.trim()\" then"; let t = y.signum();`,['float-signum']],
  [String.raw`let raw = r#"say "hi .min(c) mul_add"#; let r = x.round();`,['float-round']],
  [String.raw`let q = '"'; let m = a.max(b);`,['float-min-max']],
  [String.raw`let q = b'\''; let e = '\\'; let m = a.max(b);`,['float-min-max']],
  [String.raw`impl<'a> Wrapper<'a> { fn widest(&'a self) -> f64 { self.x.max(self.y) } }`,['float-min-max']],
 ])assert.deepEqual(rulesIn(source,'ported'),expected,source);
});

test('escaped braces, fill alignment and JSON text are not precision formats',()=>{
 for(const source of [
  'let s = format!("{{:.2}} {:?} {:x} {:>8} {:.<5} {:#010b}", a, b, c, d, e);',
  'const JSON: &str = r#"{"price":12.5,"size":{"x":1.25}}"#;',
  'let s = format!("{}{0}{name}", a, name = b);',
 ])assert.deepEqual(rulesIn(source,'ported'),[],source);
});

test('integer helpers and JS kernel calls are allowed in ported code',()=>{
 const source=[
  'let a = std::cmp::max(start, 0);',
  'let b = Ord::min(end, len);',
  'let c = usize::max(left, right) + u64::MAX as usize;',
  'let d = widths.iter().max();',
  'let e = num::js_max(&[x, y]) + num::js_round(z) + num::js_sign(w);',
  'let f = JsString::trim(&name);',
  'let g = key.trim_matches(\'"\');',
  'for i in 0..max(lo, hi) {}',
  'let h = key.trim_start_matches(\'0\').len();',
 ].join('\n');
 assert.deepEqual(findBans(source,'ported'),[]);
});

test('only string literals inside macro invocations are read as format strings',()=>{
 for(const [source,expected] of [
  ['const HINT: &str = "{:.2}";',[]],
  ['if !(label == "{:.2}") {}',[]],
  ['let s = label_format!("{:.2}", x);',['float-format']],
  ['let v = vec![format!("{:.3}", x)];',['float-format']],
  ['let s = format! ("{:.1}", x);',['float-format']],
  ['assert_eq!(bytes, b"{:.2}"); assert_eq!(text, c"{:e}");',[]],
 ])assert.deepEqual(rulesIn(source,'ported'),expected,source);
});

test('findings point at the line and column of the violation',()=>{
 const where=source=>findBans(source,'ported').map(({rule,line,column})=>({rule,line,column}));
 assert.deepEqual(where('fn f(x: f64) -> f64 {\n    x.round()\n}'),[{rule:'float-round',line:2,column:6}]);
 assert.deepEqual(where('let a = 1;\nlet s = format!("x = {:.2}", a);'),[{rule:'float-format',line:2,column:22}]);
});

test('the kernel may use {:.766e} for exact digits and no other precision format',()=>{
 assert.deepEqual(rulesIn('let d = format!("{:.766e}", x.abs());\nlet e = format!("{magnitude:.766e}");','kernel'),[]);
 for(const source of [
  'let s = format!("{:.2}", x);',
  'let s = format!("{:.765e}", x);',
  'let s = format!("{:e}", x);',
  'let s = format!("{:>800.766e}", x);',
 ])assert.deepEqual(rulesIn(source,'kernel'),['float-format'],source);
});

test('the kernel rejects serde and fused multiply-add but not the f64 helpers it implements JS semantics with',()=>{
 const source='use serde::Serialize;\nlet y = a.mul_add(b, c);\nlet m = a.max(b).round().signum();\nlet t = s.trim();';
 assert.deepEqual(rulesIn(source,'kernel'),['serde','mul-add']);
});

test('Cargo manifests reject serde dependencies and features outside TOML comments',()=>{
 const where=text=>findManifestBans(text).map(({rule,line})=>({rule,line}));
 assert.deepEqual(where('[dependencies]\n# serde는 쓰지 않는다\nryu-js = "=1.0.3" # serde 없이\n'),[]);
 assert.deepEqual(where('[dependencies]\nindexmap = { version = "2", features = ["serde"] }\n'),[{rule:'serde',line:2}]);
 assert.deepEqual(where('[dependencies.serde_json]\nversion = "1"\n'),[{rule:'serde',line:1}]);
 assert.deepEqual(where('[dependencies]\nfork = { git = "https://example.com/fork#main", features = ["serde"] }\n'),[{rule:'serde',line:2}]);
});

test('check-bans exits 1 and names file, line and rule for banned code in barochart-core and barochart-bridge',async()=>{
 const dir=await temporaryTree('barochart-check-bans-',{
  'crates/barochart-core/src/lib.rs':'//! core\npub fn widest(a: f64, b: f64) -> f64 {\n    a.max(b)\n}\n',
  'crates/barochart-bridge/src/lib.rs':'//! bridge\npub fn label(x: f64) -> String {\n    format!("{:.766e}", x)\n}\n',
  'crates/barochart-bridge/Cargo.toml':'[package]\nname = "barochart-bridge"\n\n[dependencies]\nserde = "1"\n',
 });
 try{
  const result=runCheckBans(['--root',dir]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stderr,/crates\/barochart-core\/src\/lib\.rs:3:\d+ float-min-max/);
  assert.match(result.stderr,/crates\/barochart-bridge\/src\/lib\.rs:3:\d+ float-format/);
  assert.match(result.stderr,/crates\/barochart-bridge\/Cargo\.toml:5:\d+ serde/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('check-bans exits 0 for clean ported code and kernel code outside the ported-code bans',async()=>{
 const dir=await temporaryTree('barochart-check-bans-',{
  'crates/barochart-core/src/lib.rs':'//! core: f64::max 대신 js_max를 쓴다\npub fn larger(a: usize, b: usize) -> usize {\n    std::cmp::max(a, b)\n}\n',
  'crates/barochart-js/src/lib.rs':'//! kernel\npub fn digits(x: f64) -> String {\n    format!("{:.766e}", x.abs())\n}\npub fn first(i: isize) -> isize {\n    i.max(0)\n}\n',
 });
 try{
  const result=runCheckBans(['--root',dir]);
  assert.equal(result.status,0,result.stdout+result.stderr);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('check-bans exits 2 and points at --root when the root holds none of the checked crates',async()=>{
 const dir=await temporaryTree('barochart-check-bans-',{'README.md':'not a Rust workspace\n'});
 try{
  const result=runCheckBans(['--root',dir]);
  assert.equal(result.status,2,result.stdout+result.stderr);
  assert.match(result.stderr,/--root/);
  assert.equal(runCheckBans(['--unknown-flag']).status,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('the repository Rust workspace passes check-bans and the scan reaches the kernel crate',()=>{
 const result=runCheckBans([]);
 assert.equal(result.status,0,result.stdout+result.stderr);
 assert.match(result.stdout,/barochart-js [1-9]\d* files?/);
});

/** cwd·인자·PATH를 FAKE_CARGO_LOG에 적고 FAKE_CARGO_SIGNAL 또는 FAKE_CARGO_EXIT대로 끝나는 가짜 cargo */
const FAKE_CARGO=[
 '#!/bin/sh',
 'pwd -P > "$FAKE_CARGO_LOG"',
 'printf \'%s\\n\' "$@" "$PATH" >> "$FAKE_CARGO_LOG"',
 'if [ -n "$FAKE_CARGO_SIGNAL" ]; then kill -s "$FAKE_CARGO_SIGNAL" $$; fi',
 'exit "${FAKE_CARGO_EXIT:-0}"',
 '',
].join('\n');

/**
 * 디렉터리에 실행 가능한 가짜 cargo를 둔다.
 * @param {string} binDirectory cargo를 둘 bin 디렉터리
 */
async function installFakeCargo(binDirectory){
 await mkdir(binDirectory,{recursive:true});
 await writeFile(join(binDirectory,'cargo'),FAKE_CARGO);
 await chmod(join(binDirectory,'cargo'),0o755);
}

/**
 * CARGO_HOME을 뺀 현재 환경에 덮어쓸 값을 더한다. 개발자·CI의 CARGO_HOME이 테스트에 새지 않게 한다.
 * @param {Record<string,string>} overrides 덮어쓸 환경 변수
 * @returns {NodeJS.ProcessEnv} 래퍼에 넘길 환경
 */
function cargoTestEnv(overrides){
 const env={...process.env,...overrides};
 if(!('CARGO_HOME' in overrides))delete env.CARGO_HOME;
 return env;
}

/**
 * cargo 래퍼를 저장소 밖 cwd에서 실행한다.
 * @param {string[]} args cargo 인자
 * @param {NodeJS.ProcessEnv} env 래퍼 환경
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 실행 결과
 */
const runCargoWrapper=(args,env)=>spawnSync(process.execPath,[cargoScript,...args],{cwd:tmpdir(),encoding:'utf8',env});

test('cargo.mjs runs ~/.cargo/bin cargo inside rust/ with arguments verbatim and returns its exit code',async()=>{
 const home=await mkdtemp(join(tmpdir(),'barochart-cargo-home-')),log=join(home,'calls.log');
 try{
  await installFakeCargo(join(home,'.cargo/bin'));
  const args=['clippy','--workspace','--','-D','warnings','two words','*'];
  const result=runCargoWrapper(args,cargoTestEnv({HOME:home,FAKE_CARGO_LOG:log,FAKE_CARGO_EXIT:'7'}));
  assert.equal(result.status,7,result.stderr);
  const [cwd,...rest]=(await readFile(log,'utf8')).split('\n');
  assert.equal(cwd,await realpath(join(root,'rust')));
  assert.deepEqual(rest.slice(0,args.length),args);
  assert.ok(rest[args.length].startsWith(join(home,'.cargo/bin')+delimiter),rest[args.length]);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('cargo.mjs puts CARGO_HOME/bin first when CARGO_HOME is set and returns exit code 0',async()=>{
 const home=await mkdtemp(join(tmpdir(),'barochart-cargo-home-')),log=join(home,'calls.log');
 try{
  await installFakeCargo(join(home,'custom-cargo/bin'));
  const result=runCargoWrapper(['--version'],cargoTestEnv({HOME:join(home,'no-home'),CARGO_HOME:join(home,'custom-cargo'),FAKE_CARGO_LOG:log}));
  assert.equal(result.status,0,result.stderr);
  const [,argument,path]=(await readFile(log,'utf8')).split('\n');
  assert.equal(argument,'--version');
  assert.ok(path.startsWith(join(home,'custom-cargo/bin')+delimiter),path);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('cargo.mjs exits with 128 plus the signal number when cargo is killed by a signal',async()=>{
 const home=await mkdtemp(join(tmpdir(),'barochart-cargo-home-')),log=join(home,'calls.log');
 try{
  await installFakeCargo(join(home,'.cargo/bin'));
  const result=runCargoWrapper(['build'],cargoTestEnv({HOME:home,FAKE_CARGO_LOG:log,FAKE_CARGO_SIGNAL:'TERM'}));
  assert.equal(result.status,128+constants.signals.SIGTERM,result.stderr);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('cargo.mjs explains a missing rustup cargo and exits 127',async()=>{
 const home=await mkdtemp(join(tmpdir(),'barochart-cargo-home-'));
 try{
  const result=runCargoWrapper(['build'],cargoTestEnv({HOME:home,PATH:join(home,'empty-path')}));
  assert.equal(result.status,127,result.stderr);
  assert.match(result.stderr,/rustup/);
 }finally{await rm(home,{recursive:true,force:true});}
});
