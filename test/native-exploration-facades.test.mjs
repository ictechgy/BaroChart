// Source-level lifecycle routing checks. No Swift/JSC or Android/JNI execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const swift=readFileSync(new URL('../native/AsterNative.swift',import.meta.url),'utf8');
const java=readFileSync(new URL('../native/android/java/dev/aster/charts/AsterEngine.java',import.meta.url),'utf8');
const sw=swift.slice(swift.indexOf('private func dataExploration('),swift.indexOf('public func crosshairValues('));
const ja=java.slice(java.indexOf('private JSONObject dataExploration('),java.indexOf('public void addPanel('));
function ordered(text,...parts){let i=0;for(const part of parts){const n=text.indexOf(part,i);assert.ok(n>=0,part);i=n+part.length;}}
test('Swift dedicated exploration checks owner/open and original context after conversion without notification',()=>{
 ordered(sw,'Thread.current === owner','!closed, !closing','let runtime = contextRuntime','runtime.acquireCaptureLease()','defer {runtime?.releaseCaptureLease()}','return try autoreleasepool','let source = contextBacking','source.objectForKeyedSubscript("nativeDataExploration")','function.call(withArguments:','source.exception','value.toDictionary()','source.exception','!closed, !closing, contextBacking === source','return result');
 assert.doesNotMatch(sw,/notifyChanges|command\(|setNeedsDisplay|try call\(|checkException\(|let source = context\n/);
});
test('Java dedicated exploration checks source handle after checked invocation without notification',()=>{
 ordered(ja,'check();','if(closing)','final long source=handle','invoke("nativeDataExploration"','check();','closing||handle!=source','result instanceof JSONObject','return (JSONObject)result');
 assert.doesNotMatch(ja,/notifyChanges|command\(|invalidate\(/);
});
for(const [name,action]of [['setDataExploration','setActive'],['navigateDataExploration','navigate'],['refreshDataExploration','refresh'],['readDataExploration','read']])test(`both facades expose only explicit ${action}`,()=>{
 assert.match(sw,new RegExp(`public func ${name}\\([^\\n]+dataExploration\\("${action}"`));
 assert.match(ja,new RegExp(`public JSONObject ${name}\\([^\\n]+dataExploration\\("${action}"`));
});
