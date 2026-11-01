// 이름 변경 이전 작업공간 픽스처의 플랫폼별 사본(SwiftPM 테스트 리소스, Android androidTest 자산)이 원본과 바이트 단위로 같은지 확인한다.
// 사본이 원본과 어긋나면 네이티브 복원 테스트가 다른 문서를 검사하게 되므로 드리프트를 막는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url));
const source='test/fixtures/legacy/aster-workspace-v1.json';

for(const copy of ['Tests/BaroChartTests/Resources/aster-workspace-v1.json','native/android/library/src/androidTest/assets/legacy/aster-workspace-v1.json']){
 test(`legacy workspace fixture copy matches the source: ${copy}`,async()=>{
  assert.ok((await read(copy)).equals(await read(source)),`${copy} differs from ${source}; copy the source file again`);
 });
}
