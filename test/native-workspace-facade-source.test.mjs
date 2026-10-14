import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// Static source assertions only. Separate Java checks do not execute Android/JNI.
const swift=readFileSync(new URL('../native/AsterNative.swift',import.meta.url),'utf8');
const java=readFileSync(new URL('../native/android/java/dev/aster/charts/AsterEngine.java',import.meta.url),'utf8');
function method(source,marker){const start=source.indexOf(marker);assert.ok(start>=0);const begin=source.indexOf('{',start);let depth=1,i=begin+1;for(;depth&&i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}assert.equal(depth,0);return source.slice(begin+1,i-1);}
for(const [name,source,save,preflight,call] of [
 ['Swift',swift,'public func saveWorkspace(','public func preflightWorkspace(','call'],
 ['Java',java,'public String saveWorkspace(','public JSONObject preflightWorkspace(','invoke']
])test(name+' workspace read facades use existing direct owner-checked calls without mutation notification',()=>{
 const s=method(source,save),p=method(source,preflight);
 assert.match(s,new RegExp(call+'\\("nativeSaveWorkspace"'));assert.match(p,new RegExp(call+'\\("nativePreflightWorkspace"'));
 for(const text of [s,p])assert.doesNotMatch(text,/command\(|notify|activeJob|revision|prepare/);
 assert.match(s,name==='Swift'?/result\.isString/:/result instanceof String/);
 assert.match(p,name==='Swift'?/toDictionary\(\)/:/result instanceof JSONObject/);
});
test('Swift direct call retains owning-thread and closed-engine guards before JavaScript entry',()=>{
 const body=method(swift,'public func call(');
 assert.ok(body.indexOf('Thread.current === owner')<body.indexOf('function.call'));
 assert.ok(body.indexOf('guard !closed')<body.indexOf('function.call'));
 assert.match(body,/checkException\(\)/);
});
test('Java direct invoke retains owning-thread and closed-handle guards before JNI entry',()=>{
 const check=method(java,'private void check('),body=method(java,'public Object invoke(');
 assert.match(check,/if\(Thread\.currentThread\(\)!=owner\)throw new IllegalStateException/);
 assert.match(check,/if\(handle==0\)throw new IllegalStateException/);
 assert.ok(check.indexOf('Thread.currentThread()!=owner')<check.indexOf('resumeOwnerCleanup()'));
 assert.ok(check.indexOf('resumeOwnerCleanup()')<check.indexOf('if(handle==0)'));
 assert.ok(body.indexOf('check()')<body.indexOf('call(handle'));
});
test('Java workspace close recovery remains reachable after the source handle is retired',()=>{
 const close=method(java,'@Override public void close(');
 assert.ok(close.indexOf('Thread.currentThread()!=owner')<close.indexOf('job.closeOnOwner()'));
 assert.ok(close.indexOf('job.closeOnOwner()')<close.indexOf('if(handle!=0)'));
 assert.match(close,/ParamsJob paramsClosing=activeParams;if\(paramsClosing!=null\)paramsClosing\.job\.sourceFreeStartedOnOwner\(\);handle=0;/);
 assert.match(close,/handle=0;try\{free\(released\);if\(paramsClosing!=null\)paramsClosing\.job\.sourceFreedOnOwner\(\);\}finally\{if\(activeWorkspace!=null\)activeWorkspace\.job\.closeOnOwner\(\);\}/);
});
test('Java workspace adapter uses the production initial-enqueue cleanup boundary',()=>{
 const restore=method(java,'public WorkspaceJob restoreWorkspaceAsync(String document,JSONObject binding,AsyncOptions options');
 assert.match(restore,/activeWorkspace=result;state\.enqueueInitial\(\);return result;/);
 assert.doesNotMatch(restore,/queue\.post\(state::start\)/);
 assert.match(restore,/releaseReservation\(WorkspaceRestoreJob job\)\{if\(current\(job\)\)activeWorkspace=null;/);
});
