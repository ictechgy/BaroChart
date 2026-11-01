// 네이티브 일치 테스트가 읽는 어휘 JSON이 현재 코어와 같은지 확인한다(코어가 바뀌면 재생성을 강제)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeVocabulary,VOCABULARY_OUTPUTS} from '../scripts/export-native-vocabulary.mjs';

test('exported native vocabulary matches the current core',async()=>{
 const expected=await nativeVocabulary();
 assert.equal(expected.indicators.length,35);
 assert.equal(expected.drawings.length,16);
 assert.deepEqual(expected.seriesTypes,['candles','ohlc','line','area','histogram']);
 for(const output of VOCABULARY_OUTPUTS)
  assert.deepEqual(JSON.parse(await readFile(new URL('../'+output,import.meta.url),'utf8')),expected,output+' is stale: run node scripts/export-native-vocabulary.mjs');
});
