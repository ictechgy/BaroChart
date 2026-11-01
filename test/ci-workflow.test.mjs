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

test('every action is pinned to a full commit SHA',()=>{
 const uses=[...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(match=>match[1]);
 assert.ok(uses.length>=6);
 for(const ref of uses)assert.match(ref,/@[0-9a-f]{40}$/,ref+' must be pinned to a commit SHA');
});
