// CI 워크플로: 네이티브 빌드 잡이 있고, 모든 액션은 커밋 SHA로 고정한다(공급망 위험 방지)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const workflow=await readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8');

test('native SDK build jobs run on every pull request',()=>{
 for(const job of ['ios-build','android-build','android-x86-smoke'])assert.match(workflow,new RegExp(`^  ${job}:`,'m'),job);
 assert.match(workflow,/swift build -Xswiftc -warnings-as-errors/);
 assert.match(workflow,/swift test/);
 assert.match(workflow,/OTHER_SWIFT_FLAGS=-warnings-as-errors/);
 assert.match(workflow,/check-elf-alignment\.mjs/);
 assert.match(workflow,/arch: x86_64/);
 assert.match(workflow,/kr\.coden\.barochart\.TypedEngineTest/);
});

/**
 * 잡 하나의 YAML 블록을 잘라 낸다. 다음 잡(들여쓰기 두 칸의 키)이나 파일 끝에서 멈춘다.
 * @param {string} name 잡 이름
 * @returns {string} 잡 블록(없으면 빈 문자열)
 */
function jobBlock(name){
 const lines=workflow.split('\n'),start=lines.indexOf(`  ${name}:`);
 if(start<0)return '';
 const end=lines.findIndex((line,index)=>index>start&&/^  \S/.test(line));
 return lines.slice(start,end<0?lines.length:end).join('\n');
}

test('the Rust workspace job installs the pinned toolchain and runs every Rust gate on Linux',()=>{
 const job=jobBlock('rust');
 assert.match(job,/runs-on: ubuntu-latest/);
 for(const command of [
  'rustup toolchain install',
  'node scripts/rust/cargo.mjs fmt --check',
  'node scripts/rust/cargo.mjs clippy',
  '--workspace --all-targets -- -D warnings',
  'node scripts/rust/cargo.mjs test',
  'node scripts/rust/check-bans.mjs',
  'node scripts/rust/install-cbindgen.mjs',
  'node scripts/rust/check-header.mjs',
  'node scripts/rust/c-smoke.mjs',
  'node --test test/rust-wasm-harness.test.mjs',
 ])assert.ok(job.includes(command),`rust job must run ${command}`);
 assert.match(job,/REQUIRE_WASM: '1'/);
 // 같은 코퍼스의 r(ECMA)·q(Android QuickJS)를 두 실제 엔진과 비교해야 한다.
 assert.match(job,/^\s+run: node scripts\/rust\/conformance\.mjs --count 100000 --engines v8,quickjs\s*$/m);
});

test('every action is pinned to a full commit SHA',()=>{
 const uses=[...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(match=>match[1]);
 assert.ok(uses.length>=6);
 for(const ref of uses)assert.match(ref,/@[0-9a-f]{40}$/,ref+' must be pinned to a commit SHA');
});

test('native jobs exercise the optional Rust packages and keep the JS-only lane',()=>{
 const ios=jobBlock('ios-build'),android=jobBlock('android-build'),smoke=jobBlock('android-x86-smoke');
 for(const job of [ios,android,smoke]){
  assert.match(job,/rustup toolchain install/);
  assert.match(job,/node scripts\/rust\/cargo\.mjs fetch --locked/);
  assert.match(job,/BAROCHART_RUSTUP_BIN=/,'native jobs must publish explicit rustup proxies instead of assuming a Cargo-home layout');
  assert.match(job,/rustup which "\$\{proxy\}"/,'proxies must point to the selected toolchain binary, not a package-manager rustup wrapper');
 }
 assert.match(ios,/node scripts\/rust\/build-xcframework\.mjs/);
 assert.match(ios,/BAROCHART_RUST_XCFRAMEWORK/);
 assert.match(ios,/REQUIRE_SWIFTPM: '1'/);
 assert.match(ios,/RustRuntimeTests\/testRawCallReturnsTheRustNativeInitValue/);
 assert.match(ios,/swift test/);
 assert.match(android,/-PbarochartRust=false/);
 assert.match(android,/-PbarochartQuickjs=false/);
 assert.match(smoke,/kr\.coden\.barochart\.RustRuntimeTest/);
});
