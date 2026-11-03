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
 ])assert.ok(job.includes(command),`rust job must run ${command}`);
 // 같은 코퍼스의 r(ECMA)·q(Android QuickJS)를 두 실제 엔진과 비교해야 한다.
 assert.match(job,/^\s+run: node scripts\/rust\/conformance\.mjs --count 100000 --engines v8,quickjs\s*$/m);
});

test('every action is pinned to a full commit SHA',()=>{
 const uses=[...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(match=>match[1]);
 assert.ok(uses.length>=6);
 for(const ref of uses)assert.match(ref,/@[0-9a-f]{40}$/,ref+' must be pinned to a commit SHA');
});
