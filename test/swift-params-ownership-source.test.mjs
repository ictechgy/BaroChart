import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Static source assertions only. This does not compile or execute Swift, JSC,
// ARC, DispatchQueue, or creator run loops. Apple SDK/runtime checks remain
// necessary to establish actual publication, cancellation, and release behavior.
const raw = readFileSync(new URL('../native/AsterNative.swift', import.meta.url), 'utf8');
const source = raw.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
  token => token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token);
const compact = value => value.replace(/\s+/g, '');
// Scope checks to declarations and ignore comments/string braces. Whitespace
// and unrelated source formatting are deliberately not part of this contract.
function block(scope, declaration) {
  const match = declaration.exec(scope);
  assert.ok(match, `Missing Swift declaration: ${declaration}`);
  const structure = scope.replace(/"(?:\\.|[^"\\])*"/g, token => ' '.repeat(token.length));
  let parens = 0, brackets = 0, begin = -1;
  // A default closure argument (completion: () -> Void = {}) is not the body.
  for (let i = match.index; i < structure.length; i++) {
    if (structure[i] === '(') parens++;
    else if (structure[i] === ')') parens--;
    else if (structure[i] === '[') brackets++;
    else if (structure[i] === ']') brackets--;
    else if (structure[i] === '{' && !parens && !brackets) {begin = i;break;}
  }
  assert.ok(begin >= 0, `Missing Swift body: ${declaration}`);
  let depth = 1, end = begin + 1;
  for (; end < structure.length && depth; end++) {
    if (structure[end] === '{') depth++;
    else if (structure[end] === '}') depth--;
  }
  assert.equal(depth, 0, `Unbalanced Swift body: ${declaration}`);
  return scope.slice(begin + 1, end - 1);
}
function ordered(scope, ...parts) {
  const code = compact(scope);
  let after = 0;
  for (const part of parts) {
    const fragment = compact(part), index = code.indexOf(fragment, after);
    assert.ok(index >= 0, `Expected ordered Swift source fragment: ${part}`);
    after = index + fragment.length;
  }
}
const record = block(source, /\bclass\s+AsterParamsSourceRecord\b/);
const registry = block(source, /\benum\s+AsterParamsRegistry\b/);
const job = block(source, /\bclass\s+AsterParamsJob\b/);
const engine = block(source, /\bclass\s+AsterEngine\b/);
const admission = block(source, /\benum\s+AsterNativeAdmission\b/);
const method = (scope,name) => block(scope,new RegExp(`\\bfunc\\s+${name}\\s*(?:<[^>]+>)?\\s*\\(`));
const check = (name,run) => test(`Swift params static source assertion: ${name}`,run);

check('main owner and stable source precede registration and deferred Begin', () => {
  ordered(method(engine,'setIndicatorParamsAsync'),'try asyncPreflight(timeout)','JSONSerialization.data(',
    'try asyncPreflight(timeout)','guard contextBacking === source, revision == capturedRevision',
    'AsterParamsRegistry.reserve(self,id,source,contextRuntime)','AsterParamsJob(', 'activeParams = job', 'DispatchQueue.main.async','job.start(bundle:bundle)');
  assert.doesNotMatch(method(engine,'setIndicatorParamsAsync'), /nativeParamsSourceBegin/);
  ordered(method(job,'start'),'record.began = true','nativeParamsSourceBegin','begin["registration"]','begin["ticket"]','self.params = nil','admit(ticket:ticket,bundle:bundle)');
});
check('workspace and params share opaque admission, not source registries', () => {
  for(const name of ['AsterParamsRegistry','AsterWorkspaceRegistry']) {
    const scope = block(source,new RegExp(`enum\\s+${name}\\b`));
    assert.match(method(scope,'reserve'), /AsterNativeAdmission\.reserve\(\)/);
    assert.match(method(scope,'remove'), /AsterNativeAdmission\.release\(record\.admission\)/);
  }
  ordered(method(admission,'reserve'),'guard slots < 2','slots += 1');
  ordered(method(admission,'admit'),'!lease.released','!lease.admitted','cost <= asterWorkspaceMaxBytes - bytes','bytes += cost');
  ordered(method(admission,'release'),'if lease.released {return}','lease.released = true','slots -= 1','bytes -= lease.bytes');
  assert.doesNotMatch(admission,/JSContext|Error\?|callback|NSLock/);
});
check('pending record cannot own client callbacks, Error or strong Engine/job', () => {
  const fields=record.slice(0,record.search(/\binit\s*\(/));
  assert.match(fields,/weak var engine: AsterEngine\?/);assert.match(fields,/weak var job: AsterParamsJob\?/);
  assert.match(fields,/weak var sourceIdentity: JSContext\?/);
  assert.doesNotMatch(fields,/\b(?:Error|Result|Any|AnyObject|JSValue)\b|->|\b(?:completion|callback|progress)\b/);
  ordered(method(job,'finish'),'terminal = true','lock.unlock()','params = nil','plan = nil','record = nil','let callback = completion','completion = nil','progress = nil','callback?(');
});
check('captured Status/Abort remains available after Engine close', () => {
  const recover=method(record,'recover');
  ordered(recover,'if released {return}','if !began','try autoreleasepool','guard let context = context','nativeParamsSourceStatus','if status == "active"','nativeParamsSourceAbort','guard released');
  assert.doesNotMatch(recover,/engine|closed|contextBacking|handle|ticket/);
  const close=method(engine,'close');assert.match(close,/AsterParamsRegistry\.retry\(pending\)/);assert.match(close,/activeParams\?\.cancel\(\)/);
  assert.doesNotMatch(close,/record\.released|sourceFreed|indeterminate|ParamsRegistry\.remove/);
});
check('terminal receipts bind registration, id, schema, output names and offsets', () => {
  const accept=method(record,'accept');
  for(const text of ['object["registration"]','receipt["schema"]','receipt["version"]','receipt["registration"]','receipt["id"]','receipt["status"]','Set(outputs).count','abs(number.doubleValue) <= 10000']) assert.ok(accept.includes(text),text);
  assert.match(accept,/\["active","committed","unchanged","failed","aborted"\]/);
  assert.doesNotMatch(accept,/isNull.*released|isUndefined.*released/);
});
check('late committed notification follows creator acknowledgment and budget release', () => {
  const remove=method(registry,'remove');
  ordered(remove,'record.detach','records.removeValue','AsterNativeAdmission.release','record.detaching = false','owner?.pendingParamsRegistration = nil','owner?.activeParams = nil','record.outcome == .committed','record.notified = true','!owner.closed','!owner.closing','owner.contextBacking === source','if shouldNotify {owner?.notifyChanges()}','completion()');
  ordered(method(record,'detach'),'detaching = true','context = nil','let owner = runtime','runtime = nil','releaseCaptureLease(afterRetirementIfNeeded:completion)');
  assert.doesNotMatch(registry,/NSLock|lock\(|while\s/);
  const identityPool=block(remove,/let shouldNotify: Bool = autoreleasepool/);assert.doesNotMatch(identityPool,/notifyChanges/);
});
check('one pending completion drops callbacks and leaves minimal registry record', () => {
  const settle=method(job,'settle');
  ordered(settle,'try record.recover()','AsterParamsRegistry.remove(record)');
  const pending=block(settle,/\bcatch\s*/);
  ordered(pending,'record.pending = true','engine?.pendingParamsRegistration = registration','self.record = nil','plan = nil','finish(.failure(AsterParamsError.cleanupPending(');
  assert.doesNotMatch(pending,/record\.\w+\s*=\s*(?:error|self|completion|progress)\b/);
  assert.doesNotMatch(method(registry,'retry'),/completion|finish\(|DispatchQueue|while\s/);
});
check('recovery is bounded, main-only and returns status instead of redelivery', () => {
  const retry=method(registry,'retry');
  ordered(retry,'precondition(Thread.isMainThread)','Array(records.values)','record.pending && !record.retrying && !record.detaching','record.retrying = true','try record.recover()','record.retrying = false','remove(record)','results.append(record.statusValue())');
  assert.match(compact(retry),/min\(32,record\.failures\+1\)/);
  for(const name of ['paramsCleanupStatus','retryParamsCleanup']) ordered(method(engine,name),'guard Thread.isMainThread','AsterParamsRegistry.');
  ordered(method(job,'retryCleanup'),'guard Thread.isMainThread','AsterParamsRegistry.retry(registration)');
});
check('original runtime never swaps to worker context', () => {
  assert.doesNotMatch(job,/contextBacking\s*=(?!=)|contextRuntime\s*=(?!=)|nativeAsyncFinish|nativeWorkspaceSourceFinish/);
  assert.match(method(job,'compute'),/JSContext\(virtualMachine:JSVirtualMachine\(\)\)/);
  assert.doesNotMatch(method(job,'compute'),/return context|return value|return row/);
});
check('whole worker autoreleasepool exits before owner publication or cleanup', () => {
  const admit=method(job,'admit');
  ordered(admit,'AsterNativeAdmission.admit(record.admission,plan.bytes)','Thread.detachNewThread','let result: Result<Int,Error> = autoreleasepool','compute(bundle:bundle,plan:plan)','DispatchQueue.main.async','case .success','publish(ticket:ticket)','case .failure','settle(error)');
  const thread=block(admit,/Thread\.detachNewThread/),pool=block(thread,/autoreleasepool/);
  assert.doesNotMatch(pool,/DispatchQueue|publish\(|settle\(/);
  assert.doesNotMatch(thread.slice(thread.indexOf('DispatchQueue.main.async')),/JSContext|JSValue|\bcontext\b/);
});
check('owner tasks guard cancellation and source identity around callback-capable JS', () => {
  ordered(method(job,'sourceCall'),'try check()','try finalOwner()','try autoreleasepool','nativeParamsSourceCheck','try operation(source)','try check()','try finalOwner()','return result');
  const owner=method(job,'finalOwner');assert.match(compact(owner),/engine\.activeParams===self,engine\.revision==sourceRevision/);
  assert.match(compact(owner),/engine\.contextBacking===source/);
  assert.doesNotMatch(owner,/asterInvoke|callback|notifyChanges/);
});
check('cancellation linearizes before JS publication with no JS under the lock', () => {
  const publish=method(job,'publish');
  ordered(publish,'nativeParamsSourcePrepare','try check()','try finalOwner()','lock.lock()','publishing = true','lock.unlock()','if stopped','record.outcome = .unknown','nativeParamsSourcePublish','catch {try record.recover()}','settle(nil)');
  assert.doesNotMatch(publish.slice(publish.indexOf('lock.lock()'),publish.indexOf('lock.unlock()')),/asterInvoke|accept\(|recover\(|notify/);
  const pool=block(publish,/autoreleasepool/);ordered(pool,'guard let source = record.context','nativeParamsSourcePublish');assert.doesNotMatch(pool,/settle\(|notifyChanges/);
  assert.equal((publish.match(/let source =/g)||[]).length,1);
  assert.match(compact(method(job,'cancel')),/if!terminal&&!publishing/);
  ordered(method(job,'settle'),'record.outcome == .committed || record.outcome == .unchanged','finish(.success(metrics))');
});
check('bounded owned binary copies use arm and write in one owner closure', () => {
  const compute=method(job,'compute');
  assert.equal((compute.match(/min\(16384,/g)||[]).length,2);
  ordered(compute,'Data(bytes:try asterTypedBytes(value,source,count:count),count:count*8)','nativeAsyncTargetBuffer','copyMemory');
  const arm=compute.indexOf('nativeParamsSourceArmWrite'),write=compute.indexOf('nativeAsyncTargetBuffer',arm),copy=compute.indexOf('copyMemory',write);
  assert.ok(arm>=0&&write>arm&&copy>write);assert.doesNotMatch(compute.slice(arm,copy),/DispatchQueue|onOwner|report\(|wait\(/);
  assert.match(compute,/plan.capacity \* outputs.count \* 8 <= 256\*1024\*1024/);
});
check('checkpoint transport is per bounded record and output validation chunked', () => {
  const compute=method(job,'compute');
  ordered(compute,'for ordinal in 0..<checkpointCount','try check()','nativeParamsTargetCheckpoint','text.utf16.count <= 131072','nativeParamsSourceCheckpoint','nativeParamsSourceValidate','16384','try check();return copied');
  assert.match(compute,/checkpointCount == \(plan.length == 0 \? 0 : plan.length\/256\+1\)/);
  assert.match(compute,/nativeParamsTargetStep",\[maxBars\]/);
  assert.doesNotMatch(compute,/JSONSerialization.*checkpoints|checkpoint.*joined/);
});
check('busy and source lifetime include parameters without changing generic raw context close', () => {
  ordered(method(engine,'workspaceAvailability'),'AsterParamsRegistry.contains(pending)','guard activeParams == nil');
  assert.match(method(engine,'command'),/activeParams != nil/);assert.match(method(engine,'command'),/pendingParamsRegistration.map/);
  assert.match(method(engine,'close'),/if workspaceContextInstalled \{contextBacking = nil\}/);
  assert.match(block(engine,/\bdeinit\b/),/activeParams\?\.cancel\(\)/);
});
check('progress has one queued callback and no delivery after publication', () => {
  const report=method(job,'report');
  ordered(report,'terminal || publishing || finishing','latestProgress = value','if progressPending','progressPending = true','DispatchQueue.main.async','done = terminal || publishing || finishing','progressPending = false','guard !done','try progress(value)');
  assert.match(report,/min\(32,callbackErrors \+ 1\)/);
});
