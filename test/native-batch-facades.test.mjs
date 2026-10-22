// Source routing checks; actual JVM decoder has a separate optional runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const swift=readFileSync(new URL('../native/AsterNative.swift',import.meta.url),'utf8'),java=readFileSync(new URL('../native/android/java/dev/aster/charts/AsterEngine.java',import.meta.url),'utf8');
const sw=swift.slice(swift.indexOf('/// Opt-in final-value deduplication.'),swift.indexOf('/// Synchronous retained-window maintenance'));
const ja=java.slice(java.indexOf('static final class DataBatchReceipt'),java.indexOf('/** Synchronous retained-window maintenance'));
function ordered(text,...parts){let at=0;for(const part of parts){const next=text.indexOf(part,at);assert.ok(next>=0,part);at=next+part.length;}}
test('additive false overloads preserve the legacy path before new owner/decode work',()=>{
 ordered(sw,'if !skipUnchanged {return try applyDataEvents(events)}','Thread.current === owner','contextBacking.map(ObjectIdentifier.init)','beforeRevision = revision','try unchangedDataBatch(events)');
 ordered(ja,'if(!skipUnchanged)return applyDataEvents(events);','check();','final long source=handle,beforeRevision=revision','invoke("nativeApplyUnchangedDataEvents",events)');
});
test('Swift scopes JSC aliases and lease before outer notifications and preserves source identity',()=>{
 const helper=sw.slice(sw.indexOf('private func unchangedDataBatch'));
 ordered(helper,'let runtime = contextRuntime','acquireCaptureLease()','defer {runtime?.releaseCaptureLease()}','return try autoreleasepool','let source = contextBacking','source.objectForKeyedSubscript','source.exception','value.toDictionary()','source.exception','contextBacking === source','return (receipt,unchanged)');
 assert.doesNotMatch(helper,/notifyChanges|try call\(|checkException/);
 ordered(sw,'outcome = try unchangedDataBatch(events)','contextBacking.map(ObjectIdentifier.init) == identity','} catch {','contextBacking.map(ObjectIdentifier.init) == identity {notifyChanges()}','throw error','if !outcome.1 || revision != beforeRevision {notifyChanges()}','return outcome.0');
});
test('Java validates before success notification and retains original failures after conservative same-owner notify',()=>{
 ordered(ja,'DataBatchReceipt.unchanged(envelope.get','if(closing||handle!=source)','catch(JSONException|RuntimeException|Error error)','if(!closing&&handle==source&&source!=0)','try{notifyChanges();}','error.addSuppressed(notification)','throw error','if(!unchanged||revision!=beforeRevision)notifyChanges();return receipt');
});
test('strict decoders require booleans and coherent finite integral receipt fields',()=>{
 for(const text of ['CFGetTypeID(n) != CFBooleanGetTypeID()','CFGetTypeID(n) == CFBooleanGetTypeID()','d.isFinite','d.rounded(.towardZero)==d','unchanged==same','appended==0 && version==before && after==before','version==before+1'])assert.ok(sw.includes(text),text);
 for(const text of ['instanceof Boolean','Double.isFinite(n)','n!=Math.rint(n)','appended!=0||version!=before||after!=before','version!=before+1','9007199254740991d'])assert.ok(ja.includes(text),text);
});
