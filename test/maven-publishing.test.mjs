// Android 배포 설정: kr.coden 좌표, Apache-2.0, scm, 소스·javadoc jar, 서명은 키가 있을 때만(설계 §5.6)
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

for(const [path,artifactId] of [['native/android/library/build.gradle','barochart-android'],['native/android/compose/build.gradle','barochart-compose']])
 test(`${artifactId} publishes a complete Maven publication`,async()=>{
  const gradle=await text(path);
  assert.match(gradle,/id 'maven-publish'/);
  assert.match(gradle,/singleVariant\('release'\)\s*\{\s*withSourcesJar\(\)\s*withJavadocJar\(\)\s*\}/);
  assert.match(gradle,new RegExp(`artifactId = '${artifactId}'`));
  assert.match(gradle,/groupId = 'kr\.coden'/);
  assert.match(gradle,/Apache License, Version 2\.0/);
  assert.match(gradle,/https:\/\/github\.com\/ictechgy\/BaroChart/);
  // 서명은 signing.keyId가 있을 때만 켠다(키 값은 저장소에 두지 않는다)
  assert.match(gradle,/hasProperty\('signing\.keyId'\)/);
  assert.doesNotMatch(gradle,/signing\.password\s*=|-----BEGIN PGP/);
 });
