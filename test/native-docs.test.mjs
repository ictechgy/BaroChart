// 네이티브 SDK 개발자 문서: 가이드가 있고, 영어·한국어 구조가 같으며, 코드 예제의 SDK 이름이 실제 소스에 있다
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
const text=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const PAIRS=[['docs/IOS-GUIDE.md','docs/IOS-GUIDE.ko.md'],['docs/ANDROID-GUIDE.md','docs/ANDROID-GUIDE.ko.md'],['docs/MIGRATING-FROM-ASTER.md','docs/MIGRATING-FROM-ASTER.ko.md']];

/** 제목 수준 목록(예: ['#','##','##','###']) */
const headings=markdown=>markdown.split('\n').filter(line=>/^#{1,4} /.test(line)).map(line=>line.split(' ')[0]);
/** 언어 태그가 맞는 코드 블록 본문 */
const blocks=(markdown,languages)=>[...markdown.matchAll(/```(\w+)\n([\s\S]*?)```/g)].filter(m=>languages.includes(m[1])).map(m=>m[2]).join('\n');

test('English and Korean guides exist with the same heading structure',async()=>{
 for(const [en,ko] of PAIRS)assert.deepEqual(headings(await text(ko)),headings(await text(en)),`${ko} must mirror ${en}`);
});

test('Swift examples only use declared SDK types and engine methods',async()=>{
 const sources=(await Promise.all((await readdir(new URL('../native/',import.meta.url))).filter(n=>n.endsWith('.swift')).map(n=>text('native/'+n)))).join('\n');
 for(const guide of ['docs/IOS-GUIDE.md','docs/IOS-GUIDE.ko.md','docs/MIGRATING-FROM-ASTER.md']){
  const code=blocks(await text(guide),['swift']);
  for(const type of new Set(code.match(/\bBaroChart[A-Z]\w*/g)??[]))assert.match(sources,new RegExp(`(class|struct|enum|protocol) ${type}\\b`),`${guide}: ${type}`);
  for(const [,method] of code.matchAll(/\bengine\.(\w+)\(/g))assert.match(sources,new RegExp(`func ${method}\\b`),`${guide}: engine.${method}`);
 }
});

test('Android examples only use SDK classes and engine methods that exist',async()=>{
 const dir='native/android/java/kr/coden/barochart/',names=(await readdir(new URL('../'+dir,import.meta.url))).filter(n=>n.endsWith('.java')).map(n=>n.slice(0,-5));
 const engine=await text(dir+'BaroChartEngine.java'),compose=await text('native/android/compose/src/main/kotlin/kr/coden/barochart/compose/BaroChart.kt');
 for(const guide of ['docs/ANDROID-GUIDE.md','docs/ANDROID-GUIDE.ko.md','docs/MIGRATING-FROM-ASTER.md']){
  const code=blocks(await text(guide),['kotlin','java']);
  for(const [,cls] of code.matchAll(/import kr\.coden\.barochart\.([A-Z]\w*)/g))assert.ok(names.includes(cls),`${guide}: ${cls}`);
  for(const [,method] of code.matchAll(/\bengine\.(\w+)\(/g))assert.match(engine,new RegExp(`public [^;{]*\\b${method}\\(`),`${guide}: engine.${method}`);
  if(code.includes('BaroChart(engine'))assert.match(compose,/fun BaroChart\(/);
 }
});

test('changelog and security policy carry the release essentials',async()=>{
 const changelog=await text('CHANGELOG.md'),security=await text('SECURITY.md');
 assert.match(changelog,/## \[0\.3\.0-dev\]/);
 assert.match(changelog,/BaroChart/);
 assert.match(security,/Report a vulnerability/);
 assert.match(security,/Supported versions/i);
});
