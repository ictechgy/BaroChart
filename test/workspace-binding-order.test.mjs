// 작업공간 문서는 데이터셋 바인딩의 입력 키 순서와 관계없이 같은 바이트여야 한다.
// 네이티브 호스트(Swift Dictionary, 일부 JSON 구현)는 키 순서를 보장하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {saveWorkspace} from '../src/core/index.mjs';
import {buildLegacyChart,LEGACY_BINDING} from './fixtures/legacy/build-legacy-chart.mjs';

test('workspace dataset binding is written in canonical key order',t=>{
 const {model,api}=buildLegacyChart();t.after(()=>model.dispose());
 const shuffled={adjustment:LEGACY_BINDING.adjustment,priceUnit:LEGACY_BINDING.priceUnit,key:LEGACY_BINDING.key,adjustmentVersion:LEGACY_BINDING.adjustmentVersion,revision:LEGACY_BINDING.revision};
 const canonical=saveWorkspace(api,LEGACY_BINDING),fromShuffled=saveWorkspace(api,shuffled);
 assert.equal(fromShuffled,canonical);
 assert.deepEqual(Object.keys(JSON.parse(canonical).dataset),['key','revision','adjustmentVersion','priceUnit','adjustment']);
});
