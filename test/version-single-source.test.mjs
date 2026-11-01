// 웹·iOS·Android가 package.json 버전 하나를 공유한다(설계 §3, §5.6)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('package.json carries the shared development version',async()=>{
 assert.equal(JSON.parse(await text('package.json')).version,'0.3.0-dev');
});

test('Android library reads its default version from package.json instead of a literal',async()=>{
 const gradle=await text('native/android/library/build.gradle');
 assert.doesNotMatch(gradle,/orElse\('0\.\d+\.\d+'\)/);
 assert.match(gradle,/package\.json/);
});
