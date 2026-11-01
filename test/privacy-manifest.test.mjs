// App Store 개인정보 매니페스트: SDK가 쓰는 Required Reason API(시스템 부팅 시간)를 선언하고 SwiftPM 리소스로 포함하는지 확인
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const text=path=>readFile(new URL('../'+path,import.meta.url),'utf8');

test('privacy manifest declares no tracking, no collected data and the system boot time reason',async()=>{
 const plist=await text('native/Resources/PrivacyInfo.xcprivacy'),compact=plist.replace(/\s+/g,'');
 assert.match(compact,/<key>NSPrivacyTracking<\/key><false\/>/);
 assert.match(compact,/<key>NSPrivacyCollectedDataTypes<\/key><array\/>/);
 assert.match(compact,/<key>NSPrivacyAccessedAPIType<\/key><string>NSPrivacyAccessedAPICategorySystemBootTime<\/string><key>NSPrivacyAccessedAPITypeReasons<\/key><array><string>35F9\.1<\/string><\/array>/);
});

test('SwiftPM ships the privacy manifest as a resource',async()=>{
 assert.match(await text('Package.swift'),/\.copy\("Resources\/PrivacyInfo\.xcprivacy"\)/);
});
