// 이름 변경(Aster → BaroChart) 뒤에도 이전 저장본(aster.* 스키마)이 그대로 읽히고 같은 바이트로 저장되는지 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {saveWorkspace} from '../src/core/index.mjs';
import {readWorkspaceDocument} from '../src/core/workspace.mjs';
import {buildLegacyChart,LEGACY_BINDING} from './fixtures/legacy/build-legacy-chart.mjs';

const fixture=name=>readFile(new URL(`./fixtures/legacy/${name}`,import.meta.url),'utf8');

test('pre-rename aster.workspace document is read and re-saved byte-identically',async t=>{
 const saved=await fixture('aster-workspace-v1.json'),doc=readWorkspaceDocument(saved);
 assert.equal(doc.schema,'aster.workspace');
 assert.equal(doc.version,1);
 assert.equal(doc.drawings.schema,'aster.drawings');
 const {model,api}=buildLegacyChart();t.after(()=>model.dispose());
 assert.equal(saveWorkspace(api,LEGACY_BINDING),saved);
});

test('pre-rename aster.drawings document loads and re-saves unchanged',async t=>{
 const saved=await fixture('aster-drawings.json'),{model,api}=buildLegacyChart();t.after(()=>model.dispose());
 api.loadDrawings(saved);
 assert.equal(api.saveDrawings(),saved);
 assert.equal(JSON.parse(saved).schema,'aster.drawings');
});
